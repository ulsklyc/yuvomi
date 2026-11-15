/**
 * Module: the settings registry (phase 2, C3)
 * Purpose: every setting of GET and PUT /api/v1/preferences in ONE place - where
 *          it is stored in `sync_config`, whom it belongs to (scope), who may
 *          write it, its default, how it is read back and how a write is
 *          checked. Before C3 each rule stood twice in server/routes/preferences.js
 *          (the GET answer and the PUT answer were built by hand) and a service
 *          that wanted a setting the way the route reads it had to import the
 *          route (services/cycle-reminders.js, a layer violation and a cycle).
 *
 * A LEAF UNDER THE SERVICES. This file imports server/utils/**, the door
 * server/authorize/index.ts, the shared lists from public/utils/ the route
 * imported before, and check helpers without side effects (api/formats.ts,
 * services/module-capabilities.js - a pure id grammar that happens to live under
 * services/). Never a service with a side effect, never a route, never
 * server/db.js: the connection is a parameter. `.dependency-cruiser.mjs` holds
 * that (`settings-is-a-leaf`), test:settings-registry holds that the import loads
 * no database.
 *
 * THE INTERFACE IS FOUR FUNCTIONS: readSettings, readSetting, writeSettings,
 * settingsCatalog. The entries are implementation. A new setting is one entry,
 * not a new function.
 *
 * WHAT A CALLER MUST KNOW:
 * - The order of the entries is the order of the checks and part of the
 *   contract: the first refused field decides the answer. Two fields are
 *   checked before every other one (`early`, by rank) and written at their own
 *   place: schedule_hidden_templates, then timezone_hint_dismissed.
 * - writeSettings opens no transaction of its own around the patch: the caller
 *   holds one (whole patch or nothing, #1622) and maps a refusal to HTTP. Two
 *   entries nest a `transaction()` (a savepoint inside the caller's one), as the
 *   route did before: the zone with its re-keying, the module list with its sync.
 * - Side effects come in as `effects`; this file does not know the services.
 *
 * Erasable TS syntax only (runs through type stripping, no build).
 */

import { authorize, VISIBILITY_VALUES } from '../authorize/index.ts';
import type { Actor, Database } from '../authorize/index.ts';
import { str, MAX_SHORT } from '../api/formats.ts';
import { isSupportedLocale, resolveHouseholdLocale } from '../utils/i18n.js';
import { householdTimeZone, isValidTimeZone } from '../utils/timezone.js';
import {
  COUNTRY_ISO_RE,
  DEFAULT_APP_NAME,
  DEFAULT_BUDGET_MODE,
  DEFAULT_CALENDAR_DURATION,
  DEFAULT_CURRENCY,
  DEFAULT_DATE_FORMAT,
  DEFAULT_MEAL_TYPES,
  DEFAULT_TIME_FORMAT,
  DEFAULT_WEEK_START,
  HEX_COLOR_RE,
  MAX_CALENDAR_DURATION,
  MAX_CALENDAR_TARGET_LENGTH,
  MAX_COUNTDOWN_GRACE_DAYS,
  MAX_DEFAULT_REMINDERS,
  MAX_MEAL_TYPE_NAME,
  MAX_TASK_POINTS,
  MIN_CALENDAR_DURATION,
  MODULE_ORDER_RE,
  SCHEDULE_TEMPLATE_KEYS,
  SUBDIVISION_RE,
  TOGGLEABLE_MODULES,
  VALID_BUDGET_MODES,
  VALID_DATE_FORMATS,
  VALID_LANGUAGES,
  VALID_MEAL_TYPES,
  VALID_REMINDER_OFFSETS,
  VALID_TIME_FORMATS,
  VALID_WEATHER_PROVIDERS,
  VALID_WEATHER_UNITS,
  VALID_WEEK_STARTS,
  isValidRegionValue,
  normalizeMobileNavOrder,
  normalizeWidgetConfig,
  parseCountdownGraceDays,
  parseDefaultReminders,
  parseDisabledModules,
  parseHiddenModules,
  parseMealTypeNames,
  parseMobileNavOrder,
  parseModuleOrder,
  parsePhoneWidgetConfig,
  parseScheduleHiddenTemplates,
  parseTaskDefaultPoints,
  parseWidgetConfig,
} from './values.ts';
// Shared isomorphic util (#620, allowlist in test/test-layer-boundary.js): the
// same id format the event modal and the settings use.
import { parseSyncTargetValue } from '../../public/utils/sync-target.js';
// The selectable currencies - one list for server and browser (#841, allowlist
// in test/test-layer-boundary.js).
import { CURRENCY_CODES } from '../../public/utils/currency-codes.js';
import { withTx, type TxDatabase } from '../db/tx.ts';

// --------------------------------------------------------------------------
// The interface types
// --------------------------------------------------------------------------

/**
 * `household`: one value for the household. `personal`: one value per account,
 * stored as `<key>:user:<id>` (a personal value may fall back on an old
 * household value when it was never set - dashboard, module order).
 * `household-default`: a household value an account can narrow or override
 * with its own (dashboard defaults, the cycle switch, the household weather).
 */
type Scope = 'household' | 'household-default' | 'personal';
/** `none`: read only (derived views, `holiday_last_sync`). */
type WriteRight = 'admin' | 'member' | 'none';

export type CatalogEntry = Readonly<{
  field: string;
  /** Every `sync_config` key the field reads or writes; `<key>:user:<id>` per account. */
  storage: readonly string[];
  scope: Scope;
  write: WriteRight;
  /** Fields that share one admin gate in the route: `weather`, `holidays`. */
  gate?: string;
  /**
   * Checked (gate, then form) before every other field, in the order of this
   * rank, and written at the entry's own place in the order.
   */
  early?: number;
}>;

export type Refusal =
  | { kind: 'forbidden' }
  | { kind: 'invalid'; message: string }
  | { kind: 'unauthenticated' };

/** A connection that can nest a transaction (withTx, both drivers). */
export type SettingsDatabase = Database & TxDatabase;

export type Effects = Readonly<{
  /** The household zone was written: re-key the series' occurrences (#2034, F5). */
  householdZoneChanged(db: SettingsDatabase, zoneBefore: string, zoneAfter: string): void;
  /** `health` came into or left the disabled modules: re-sync the fasting reminders. */
  healthModuleToggled(db: SettingsDatabase): void;
  /** The person's opt-in for their caregivers changed: sync their prevention reminders. */
  preventionCaregiversChanged(db: SettingsDatabase, userId: number | null): void;
}>;

// --------------------------------------------------------------------------
// Storage
// --------------------------------------------------------------------------

function userKey(key: string, userId: number | null): string {
  return `${key}:user:${Number(userId)}`;
}

function storedValue(db: SettingsDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

function storeValue(db: SettingsDatabase, key: string, value: unknown): void {
  db.prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function deleteValue(db: SettingsDatabase, key: string): void {
  db.prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

type ReadContext = Readonly<{
  db: SettingsDatabase;
  userId: number | null;
  /** A household key. */
  get(key: string): string | null;
  /** A key of the reading account; null without an account. */
  own(key: string): string | null;
}>;

type WriteContext = ReadContext & Readonly<{
  patch: Record<string, unknown>;
  effects: Effects;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Without an account these do nothing, as before C3. */
  setOwn(key: string, value: unknown): void;
  /**
   * Deleting the own value means "I follow the household again" - and it stays
   * that after the next change of the admin. COPYING the household value
   * instead would be the obvious and the wrong variant: it freezes today's
   * state on the account, and the follower drifts away silently from the first
   * later change (#827).
   */
  deleteOwn(key: string): void;
}>;

function readContext(db: SettingsDatabase, userId: number | null): ReadContext {
  // One read pass writes nothing, so a value read twice is the same value.
  const seen = new Map<string, string | null>();
  const get = (key: string) => {
    if (!seen.has(key)) seen.set(key, storedValue(db, key));
    return seen.get(key) ?? null;
  };
  return Object.freeze({
    db,
    userId,
    get,
    own: (key: string) => (userId ? get(userKey(key, userId)) : null),
  });
}

function writeContext(db: SettingsDatabase, userId: number | null, patch: Record<string, unknown>, effects: Effects): WriteContext {
  return Object.freeze({
    db,
    userId,
    patch,
    effects,
    get: (key: string) => storedValue(db, key),
    own: (key: string) => (userId ? storedValue(db, userKey(key, userId)) : null),
    set: (key: string, value: unknown) => storeValue(db, key, value),
    delete: (key: string) => deleteValue(db, key),
    setOwn: (key: string, value: unknown) => { if (userId) storeValue(db, userKey(key, userId), value); },
    deleteOwn: (key: string) => { if (userId) deleteValue(db, userKey(key, userId)); },
  });
}

const invalid = (message: string): Refusal => ({ kind: 'invalid', message });

/**
 * Three questions, three views - the same pattern as language and time zone:
 * what counts for me, what has the household set as its default, and do I still
 * follow it at all.
 *
 * THE DEFAULT HAS A KEY OF ITS OWN (#827). The old household-wide
 * `dashboard_widgets` is a fossil from the time before #585: it carries what
 * somebody saved last, not what an admin would have chosen as the default.
 * Overwriting it would declare a chance state a deliberate decision - and the
 * interface could no longer tell "no default set yet" from "this is how it
 * should be". It therefore stays and works as the last stage of the chain, so
 * existing households keep their familiar arrangement.
 *
 * A SECOND reason for the own key stands in test-settings-admin-gate.js: a key
 * written for the household AND per account is not decidable for that guard
 * (`ambiguous`), and its limit is used up with the weather and the cycle switch.
 */
function dashboardDefaults(ctx: ReadContext): { widgets: string | null; glance: string | null } {
  return {
    widgets: ctx.get('dashboard_widgets_default') ?? ctx.get('dashboard_widgets'),
    glance: ctx.get('dashboard_today_glance_default') ?? ctx.get('dashboard_today_glance'),
  };
}

// --------------------------------------------------------------------------
// Entries
// --------------------------------------------------------------------------

type Entry = CatalogEntry & Readonly<{
  /** The value in the answer of GET and PUT. */
  read(ctx: ReadContext): unknown;
  /** An `early` field: checked before every other field (gate first, then this). */
  check?(input: unknown, ctx: WriteContext): Refusal | null;
  /** Checks and writes at the field's place in the order; absent for `write: 'none'`. */
  apply?(input: unknown, ctx: WriteContext): Refusal | null;
}>;

const USER = ':user:<id>';

/** A boolean household switch: `true`/`false` stored as '1'/'0'. */
function householdFlag(field: string, write: WriteRight, message: string, read: (stored: string | null) => boolean): Entry {
  return {
    field,
    storage: [field],
    scope: 'household',
    write,
    read: (ctx) => read(ctx.get(field)),
    apply(input, ctx) {
      if (typeof input !== 'boolean') return invalid(message);
      ctx.set(field, input ? '1' : '0');
      return null;
    },
  };
}

/** A personal boolean: '1'/'0' under `<key>:user:<id>`. */
function personalFlag(field: string, key: string, message: string): Entry {
  return {
    field,
    storage: [key + USER],
    scope: 'personal',
    write: 'member',
    read: (ctx) => ctx.own(key) === '1',
    apply(input, ctx) {
      if (typeof input !== 'boolean') return invalid(message);
      ctx.setOwn(key, input ? '1' : '0');
      return null;
    },
  };
}

/** A household value out of a fixed list; an invalid stored value reads as the default. */
function householdChoice(field: string, write: WriteRight, values: readonly string[], fallback: string, label: string): Entry {
  return {
    field,
    storage: [field],
    scope: 'household',
    write,
    read: (ctx) => (values.includes(ctx.get(field) as string) ? ctx.get(field) : fallback),
    apply(input, ctx) {
      if (!values.includes(input as string)) return invalid(`Invalid ${label}. Allowed: ${values.join(', ')}`);
      ctx.set(field, input);
      return null;
    },
  };
}

/** A widget layout; `phone` keeps only id, visibility and order. */
function applyWidgets(field: string, input: unknown, store: (value: string) => void, remove: () => void, phone = false): Refusal | null {
  if (input === null) { remove(); return null; }
  if (!Array.isArray(input)) return invalid(`${field} must be an array.`);
  const normalized = normalizeWidgetConfig(input);
  if (normalized === null) return invalid(`${field} contains invalid entries.`);
  store(JSON.stringify(phone ? normalized.map(({ id, visible, order }) => ({ id, visible, order })) : normalized));
  return null;
}

/** A sync target id (#620, #695): trimmed, at most 500 characters, of a known form. */
function checkTarget(field: string, input: unknown): { target: string } | Refusal {
  if (input !== null && typeof input !== 'string') return invalid(`${field} must be a string.`);
  const target = ((input as string | null) ?? '').trim();
  if (target.length > MAX_CALENDAR_TARGET_LENGTH) {
    return invalid(`${field} may be at most ${MAX_CALENDAR_TARGET_LENGTH} characters long.`);
  }
  return { target };
}

const latitude = (input: unknown) => {
  const v = parseFloat(input as string);
  return Number.isNaN(v) || v < -90 || v > 90 ? null : v;
};
const longitude = (input: unknown) => {
  const v = parseFloat(input as string);
  return Number.isNaN(v) || v < -180 || v > 180 ? null : v;
};

/**
 * THE ENTRIES IN THE ORDER OF THE CHECKS AND WRITES - this order is the contract
 * (see the head; the two `early` entries are checked first and written here).
 * Read-only entries stand next to the field they derive from; the order of the
 * ANSWER is ANSWER_ORDER below.
 */
const ENTRIES: readonly Entry[] = [
  {
    field: 'visible_meal_types',
    storage: ['visible_meal_types'],
    scope: 'household',
    write: 'member',
    read: (ctx) => (ctx.get('visible_meal_types') ?? DEFAULT_MEAL_TYPES).split(',').filter((t) => VALID_MEAL_TYPES.includes(t)),
    apply(input, ctx) {
      if (!Array.isArray(input)) return invalid('visible_meal_types must be an array.');
      const filtered = input.filter((t) => VALID_MEAL_TYPES.includes(t));
      if (filtered.length === 0) return invalid('At least one meal type must be active.');
      ctx.set('visible_meal_types', filtered.join(','));
      return null;
    },
  },
  {
    field: 'meal_type_names',
    storage: ['meal_type_names'],
    scope: 'household',
    write: 'member',
    // READ BACK FROM THE DATABASE, not from the request: the client sees exactly
    // what was stored - trimmed, cut, unknown slots sorted out - not its input.
    read: (ctx) => parseMealTypeNames(ctx.get('meal_type_names')),
    apply(input, ctx) {
      if (input === null) { ctx.set('meal_type_names', ''); return null; }
      if (typeof input !== 'object' || Array.isArray(input)) return invalid('meal_type_names must be an object.');
      // Every value sent must be a string - a number or a nested object would be
      // a caller's error and must not pass silently as an empty name. Which SLOTS
      // count is decided by the allowlist in parseMealTypeNames(): an unknown slot
      // is no error of the caller, but nothing we store.
      for (const [slot, value] of Object.entries(input as Record<string, unknown>)) {
        if (value !== null && typeof value !== 'string') return invalid(`meal_type_names.${slot} must be a string.`);
        if (typeof value === 'string' && value.trim().length > MAX_MEAL_TYPE_NAME) {
          return invalid(`meal_type_names.${slot} may be at most ${MAX_MEAL_TYPE_NAME} characters long.`);
        }
      }
      // Stored normalised through parseMealTypeNames (trimmed, empty names
      // dropped): the row holds exactly what the read path would make of it, and
      // an empty object is the way back to the built-in words.
      const names = parseMealTypeNames(JSON.stringify(input));
      ctx.set('meal_type_names', Object.keys(names).length ? JSON.stringify(names) : '');
      return null;
    },
  },
  // The household's currency - admin only since C4 (E9), like region and data
  // language: every amount of the budget is shown in it.
  {
    field: 'currency',
    storage: ['currency'],
    scope: 'household',
    write: 'admin',
    read: (ctx) => ctx.get('currency') ?? DEFAULT_CURRENCY,
    apply(input, ctx) {
      if (!CURRENCY_CODES.includes(input as string)) return invalid(`Invalid currency. Allowed: ${CURRENCY_CODES.join(', ')}`);
      ctx.set('currency', input);
      return null;
    },
  },
  householdChoice('date_format', 'member', VALID_DATE_FORMATS, DEFAULT_DATE_FORMAT, 'date format'),
  householdChoice('time_format', 'member', VALID_TIME_FORMATS, DEFAULT_TIME_FORMAT, 'time format'),
  // Week start - household-wide, every member may change it (like date/time format).
  householdChoice('week_start', 'member', VALID_WEEK_STARTS, DEFAULT_WEEK_START, 'week start'),
  // Budget mode - a household-wide decision of principle, admin only (#476/#505).
  householdChoice('budget_mode', 'admin', VALID_BUDGET_MODES, DEFAULT_BUDGET_MODE, 'budget mode'),
  // Which region preset the user chose. Needed because several regions share the
  // same currency/date/time triple, and the dropdown would jump to the wrong
  // region after saving otherwise (#486).
  //
  // Since the data language is derived from the region, this is no mere display
  // aid any more: a region moves the language birthday events are stored in.
  // Hence the same admin gate as `language` - otherwise the protection there
  // could be bypassed this way. The interface always treated the region as an
  // admin field, only the route did not.
  {
    field: 'region',
    storage: ['region'],
    scope: 'household',
    write: 'admin',
    read: (ctx) => ctx.get('region') || null,
    apply(input, ctx) {
      if (input !== null && !isValidRegionValue(input)) return invalid('Invalid region.');
      ctx.set('region', input ?? '');
      return null;
    },
  },
  // The household's zone (#829) - the same kind of decision of principle as
  // region and data language, so the same admin gate. null/'' goes back to
  // "automatic", then TZ -> system zone -> UTC counts again.
  //
  // The value is no display aid: the calendar day server jobs call "today", the
  // zone in the ICS feed foreign calendars subscribe to, and the wall clock events
  // go out to Google and Outlook with hang on it. A member must not change it for
  // everybody.
  {
    field: 'timezone',
    storage: ['household_timezone', 'household_timezone_hint_dismissed'],
    scope: 'household',
    write: 'admin',
    read: (ctx) => ctx.get('household_timezone') || null,
    apply(input, ctx) {
      if (input !== null && input !== '' && !isValidTimeZone(input)) {
        return invalid('Invalid time zone. Expected an IANA zone such as "Europe/Berlin".');
      }
      // Every series that carries zoneless digits next to a `tzid` moves with the
      // zone (#1993): its start is the HOUSEHOLD's wall clock. Its exceptions and
      // single occurrences name the original start (#2034, format A) and are
      // re-keyed in the same transaction (F5).
      withTx(ctx.db, () => {
        const zoneBefore = householdTimeZone(ctx.db);
        if (input === null || input === '') ctx.delete('household_timezone');
        else ctx.set('household_timezone', input);
        ctx.effects.householdZoneChanged(ctx.db, zoneBefore, householdTimeZone(ctx.db));
      });
      // Who writes the zone has decided - also with "automatic". Without the flag
      // a deliberate reset would look like "never set", and the hint would come
      // back for every admin.
      ctx.set('household_timezone_hint_dismissed', '1');
      return null;
    },
  },
  {
    // Two views like the language: what is chosen (the select's state) and what
    // counts right now. `timezone_effective` is never empty - without a setting it
    // holds the zone the server falls back on, and exactly that one the interface
    // must be able to show as the "automatic" label (#829).
    field: 'timezone_effective',
    storage: ['household_timezone'],
    scope: 'household',
    write: 'none',
    read: (ctx) => householdTimeZone(ctx.db),
  },
  // The flag of the zone hint (#1607): "keep it" counts for the whole household,
  // so the same admin gate as the zone itself. A sync_config key of its own and
  // no column: the setting it belongs to lives there as well. Checked at the top
  // for the same reason as the templates (after them), written here, after the zone.
  {
    field: 'timezone_hint_dismissed',
    storage: ['household_timezone_hint_dismissed'],
    scope: 'household',
    write: 'admin',
    early: 2,
    // Has an admin answered "take the browser's zone?" already (#1607)?
    // `timezone: null` alone does not say it: "never set" and "deliberately
    // automatic" look the same. Household-wide, so the answer counts for every
    // admin on every device.
    read: (ctx) => ctx.get('household_timezone_hint_dismissed') === '1',
    check: (input) => (typeof input === 'boolean' ? null : invalid('timezone_hint_dismissed must be true or false.')),
    apply(input, ctx) {
      if (input) ctx.set('household_timezone_hint_dismissed', '1');
      else ctx.delete('household_timezone_hint_dismissed');
      return null;
    },
  },
  // The data language - a household-wide decision of principle like region and
  // currency, therefore admin only. null/'' goes back to "automatic" (from the
  // region).
  {
    field: 'language',
    storage: ['language'],
    scope: 'household',
    write: 'admin',
    // Three views on the same setting, because three different questions stand
    // behind it: what is chosen (the select's state), what counts right now (an
    // API consumer), and what the automatic would give (the label of the first
    // option).
    read: (ctx) => (isSupportedLocale(ctx.get('language')) ? ctx.get('language') : null),
    apply(input, ctx) {
      if (input !== null && input !== '' && !isSupportedLocale(input)) {
        return invalid(`Invalid language. Allowed: ${VALID_LANGUAGES.join(', ')}`);
      }
      if (input === null || input === '') ctx.delete('language');
      else ctx.set('language', input);
      return null;
    },
  },
  {
    field: 'language_effective',
    storage: ['language', 'region'],
    scope: 'household',
    write: 'none',
    read: (ctx) => resolveHouseholdLocale(ctx.db),
  },
  {
    field: 'language_auto',
    storage: ['region'],
    scope: 'household',
    write: 'none',
    read: (ctx) => resolveHouseholdLocale(ctx.db, { ignoreExplicit: true }),
  },
  // The household's name in the title bar - admin only since C4 (E9).
  {
    field: 'app_name',
    storage: ['app_name'],
    scope: 'household',
    write: 'admin',
    read: (ctx) => ctx.get('app_name') ?? DEFAULT_APP_NAME,
    apply(input, ctx) {
      const checked = str(input, 'Application name', { max: MAX_SHORT, required: false });
      if (checked.error) return invalid(checked.error);
      if (checked.value) ctx.set('app_name', checked.value);
      else ctx.delete('app_name');
      return null;
    },
  },
  // THE OVERVIEW BELONGS TO THE PERSON, NOT TO THE HOUSEHOLD (#585).
  //
  // Choice, order and size of the tiles were household-wide: who deselected the
  // cycle widget for themself took it from everybody, and who pulled the tasks to
  // the top moved them for the children too. That was the request - a family has
  // different needs on the same page. The pattern stood next door already:
  // `module_order` reads per user WITH a household fallback and writes per user
  // only.
  //
  // NO DUAL WRITE, and that is a decision, not convenience. A key that knows both
  // ways is no longer decidable for test-settings-admin-gate.js (`ambiguous`) -
  // every such key costs reach there, and the limit is used up with the weather
  // and the cycle. The old household value therefore stays and works only as the
  // fallback: existing households keep seeing their familiar arrangement, each
  // gets their own only the moment they change something. That is why this step
  // needs no migration either.
  //
  // The "Today at a glance" band (#740) moves along because it is saved in the
  // same PUT: kept household-wide, a personal hide would still switch it off for
  // everybody - exactly the break #585 reports.
  // `null` is no empty layout here but the way back: my own state is deleted,
  // and the household default counts again - today and after every later change
  // of it (#827).
  {
    field: 'dashboard_widgets',
    storage: ['dashboard_widgets' + USER, 'dashboard_widgets_default', 'dashboard_widgets'],
    scope: 'personal',
    write: 'member',
    // Own arrangement, else the household's (#585). The note-category filter of
    // the answer stays in the route: it needs the category catalog (a service).
    read: (ctx) => parseWidgetConfig(ctx.own('dashboard_widgets') ?? dashboardDefaults(ctx).widgets),
    apply: (input, ctx) => applyWidgets('dashboard_widgets', input,
      (value) => ctx.setOwn('dashboard_widgets', value), () => ctx.deleteOwn('dashboard_widgets')),
  },
  {
    field: 'dashboard_widgets_phone',
    storage: ['dashboard_widgets_phone' + USER],
    scope: 'personal',
    write: 'member',
    // The phone view: an own arrangement (order + visible, no size), else null
    // (-> follows the desktop). Stored like mobile_nav_order - per user, without a
    // household default. Null signals "no own phone layout".
    read: (ctx) => {
      const own = ctx.own('dashboard_widgets_phone');
      return own !== null ? parsePhoneWidgetConfig(own) : null;
    },
    apply: (input, ctx) => applyWidgets('dashboard_widgets_phone', input,
      (value) => ctx.setOwn('dashboard_widgets_phone', value), () => ctx.deleteOwn('dashboard_widgets_phone'), true),
  },
  {
    field: 'dashboard_today_glance',
    storage: ['dashboard_today_glance' + USER, 'dashboard_today_glance_default', 'dashboard_today_glance'],
    scope: 'personal',
    write: 'member',
    read: (ctx) => (ctx.own('dashboard_today_glance') ?? dashboardDefaults(ctx).glance) !== '0',
    apply(input, ctx) {
      if (input === null) { ctx.deleteOwn('dashboard_today_glance'); return null; }
      if (typeof input !== 'boolean') return invalid('dashboard_today_glance must be a boolean.');
      ctx.setOwn('dashboard_today_glance', input ? '1' : '0');
      return null;
    },
  },
  // THE HOUSEHOLD'S DEFAULT (#827). It counts for everybody who has not set up an
  // overview of their own yet - typically the members who never enter the
  // customise mode. Hence the admin gate as for region, data language and zone.
  //
  // IT OVERWRITES NOBODY. Who has an own arrangement keeps it; a household value
  // that flattens personal arrangements is the kind of switch one uses once and
  // regrets afterwards. Its price is the way back above - without it the default
  // would be invisible to everyone who ever moved a tile.
  {
    field: 'dashboard_widgets_default',
    storage: ['dashboard_widgets_default'],
    scope: 'household-default',
    write: 'admin',
    // The household's default, so the interface can show where a reset leads.
    // `null` means: there is none. The note-category filter stays in the route.
    read: (ctx) => (ctx.get('dashboard_widgets_default') === null
      ? null
      : parseWidgetConfig(ctx.get('dashboard_widgets_default'))),
    apply: (input, ctx) => applyWidgets('dashboard_widgets_default', input,
      (value) => ctx.set('dashboard_widgets_default', value), () => ctx.delete('dashboard_widgets_default')),
  },
  {
    field: 'dashboard_today_glance_default',
    storage: ['dashboard_today_glance_default'],
    scope: 'household-default',
    write: 'admin',
    read: (ctx) => (ctx.get('dashboard_today_glance_default') ?? '1') !== '0',
    apply(input, ctx) {
      if (input === null) { ctx.delete('dashboard_today_glance_default'); return null; }
      if (typeof input !== 'boolean') return invalid('dashboard_today_glance_default must be a boolean.');
      ctx.set('dashboard_today_glance_default', input ? '1' : '0');
      return null;
    },
  },
  {
    // Do I follow the default? Only who has stored NOTHING of their own does -
    // and only for them "reset" has nothing to do.
    field: 'dashboard_follows_default',
    storage: ['dashboard_widgets' + USER, 'dashboard_today_glance' + USER],
    scope: 'personal',
    write: 'none',
    read: (ctx) => ctx.own('dashboard_widgets') === null && ctx.own('dashboard_today_glance') === null,
  },
  {
    field: 'dashboard_follows_phone_default',
    storage: ['dashboard_widgets_phone' + USER],
    scope: 'personal',
    write: 'none',
    read: (ctx) => ctx.own('dashboard_widgets_phone') === null,
  },
  {
    field: 'disabled_modules',
    storage: ['disabled_modules'],
    scope: 'household',
    write: 'admin',
    read: (ctx) => parseDisabledModules(ctx.get('disabled_modules')),
    apply(input, ctx) {
      if (!Array.isArray(input)) return invalid('disabled_modules must be an array.');
      const unique = [...new Set(input.filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m)))];
      const healthChanged = parseDisabledModules(ctx.get('disabled_modules')).includes('health')
        !== unique.includes('health');
      withTx(ctx.db, () => {
        ctx.set('disabled_modules', JSON.stringify(unique));
        if (healthChanged) ctx.effects.healthModuleToggled(ctx.db);
      });
      return null;
    },
  },
  // Personally hidden modules (#673) - on purpose WITHOUT an admin check, that is
  // the whole point: before, only an admin could switch modules off, and for
  // everybody at once. See parseHiddenModules for the line to the household
  // switch above.
  {
    field: 'hidden_modules',
    storage: ['hidden_modules' + USER],
    scope: 'personal',
    write: 'member',
    read: (ctx) => parseHiddenModules(ctx.own('hidden_modules')),
    apply(input, ctx) {
      if (!Array.isArray(input)) return invalid('hidden_modules must be an array.');
      const unique = [...new Set(input.filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m)))];
      ctx.setOwn('hidden_modules', JSON.stringify(unique));
      return null;
    },
  },
  {
    field: 'module_order',
    storage: ['module_order' + USER, 'module_order'],
    scope: 'personal',
    write: 'member',
    read: (ctx) => parseModuleOrder(ctx.own('module_order') ?? ctx.get('module_order')),
    apply(input, ctx) {
      if (!Array.isArray(input)) return invalid('module_order must be an array.');
      const unique = [...new Set(input.filter((id) => typeof id === 'string' && MODULE_ORDER_RE.test(id)))];
      ctx.setOwn('module_order', JSON.stringify(unique));
      return null;
    },
  },
  {
    field: 'mobile_nav_order',
    storage: ['mobile_nav_order' + USER],
    scope: 'personal',
    write: 'member',
    read: (ctx) => parseMobileNavOrder(ctx.own('mobile_nav_order')),
    apply(input, ctx) {
      if (!Array.isArray(input)) return invalid('mobile_nav_order must be an array.');
      ctx.setOwn('mobile_nav_order', JSON.stringify(normalizeMobileNavOrder(input)));
      return null;
    },
  },
  // Housekeeping payment tasks and the default length of new events count for
  // the whole household - admin only since C4 (E9).
  householdFlag('housekeeping_payment_tasks', 'admin', 'housekeeping_payment_tasks must be a boolean', (v) => v === '1'),
  {
    field: 'calendar_default_duration',
    storage: ['calendar_default_duration'],
    scope: 'household',
    write: 'admin',
    read: (ctx) => Number(ctx.get('calendar_default_duration')) || DEFAULT_CALENDAR_DURATION,
    apply(input, ctx) {
      const minutes = Number(input);
      if (!Number.isInteger(minutes) || minutes < MIN_CALENDAR_DURATION || minutes > MAX_CALENDAR_DURATION) {
        return invalid(`calendar_default_duration must be an integer between ${MIN_CALENDAR_DURATION} and ${MAX_CALENDAR_DURATION}`);
      }
      ctx.set('calendar_default_duration', String(minutes));
      return null;
    },
  },
  // Default reminders for new events (#497, per user).
  {
    field: 'calendar_default_reminders',
    storage: ['calendar_default_reminders' + USER],
    scope: 'personal',
    write: 'member',
    read: (ctx) => parseDefaultReminders(ctx.own('calendar_default_reminders')),
    apply(input, ctx) {
      if (!Array.isArray(input)) return invalid('calendar_default_reminders must be an array.');
      const nums = input.map(Number);
      if (nums.some((n) => !VALID_REMINDER_OFFSETS.includes(n))) {
        return invalid(`calendar_default_reminders: allowed offsets (minutes): ${VALID_REMINDER_OFFSETS.join(', ')}.`);
      }
      const unique = [...new Set(nums)].sort((a, b) => a - b);
      if (unique.length > MAX_DEFAULT_REMINDERS) {
        return invalid(`calendar_default_reminders may hold at most ${MAX_DEFAULT_REMINDERS} reminders.`);
      }
      ctx.setOwn('calendar_default_reminders', JSON.stringify(unique));
      return null;
    },
  },
  // Assign new events to me by default (#498, per user). Takes any value: a
  // truthy one stores '1' (held as today's behaviour by test:settings-registry).
  {
    field: 'calendar_default_assign_me',
    storage: ['calendar_default_assign_me' + USER],
    scope: 'personal',
    write: 'member',
    read: (ctx) => ctx.own('calendar_default_assign_me') === '1',
    apply(input, ctx) {
      ctx.setOwn('calendar_default_assign_me', input ? '1' : '0');
      return null;
    },
  },
  // Default sync target for one's own new events (#620, per user).
  {
    field: 'calendar_default_target',
    storage: ['calendar_default_target' + USER],
    scope: 'personal',
    write: 'member',
    read: (ctx) => ctx.own('calendar_default_target') || '',
    apply(input, ctx) {
      const checked = checkTarget('calendar_default_target', input);
      if ('kind' in checked) return checked;
      // Empty = "save locally" and so the explicit deselection of a target set
      // before. parseSyncTargetValue gives {kind:'local'} for it, a valid value,
      // and null only for a real error of form.
      if (parseSyncTargetValue(checked.target) === null) {
        return invalid('calendar_default_target: expected "google:<id>", "caldav:<accountId>|<url>" or "outlook:<accountId>|<calendarId>".');
      }
      ctx.setOwn('calendar_default_target', checked.target);
      return null;
    },
  },
  // Default reminder list for one's own new tasks (#695, per user). Only the form
  // is checked; whether the list is still shared is decided by the tasks route on
  // create. Refusing a target here because a list was deselected in the meantime
  // would make the setting unsavable without the reason being visible here.
  // The same form as calendar_default_target, so both dialogs name their target
  // alike.
  {
    field: 'tasks_default_target',
    storage: ['tasks_default_target' + USER],
    scope: 'personal',
    write: 'member',
    read: (ctx) => ctx.own('tasks_default_target') || '',
    apply(input, ctx) {
      const checked = checkTarget('tasks_default_target', input);
      if ('kind' in checked) return checked;
      const parsed = parseSyncTargetValue(checked.target) as { kind?: string } | null;
      if (parsed === null || parsed.kind === 'google') {
        return invalid('tasks_default_target: expected "caldav:<accountId>|<url>".');
      }
      ctx.setOwn('tasks_default_target', checked.target);
      return null;
    },
  },
  // Visibility and lock as personal presets for new tasks (#2125). Defaults "all"
  // and false, so the dialog works unchanged as long as nobody set anything.
  {
    field: 'tasks_default_visibility',
    storage: ['tasks_default_visibility' + USER],
    scope: 'personal',
    write: 'member',
    read: (ctx) => ctx.own('tasks_default_visibility') || 'all',
    apply(input, ctx) {
      if (!(VISIBILITY_VALUES as readonly unknown[]).includes(input)) {
        return invalid('tasks_default_visibility must be "all", "assignees" or "private".');
      }
      ctx.setOwn('tasks_default_visibility', input);
      return null;
    },
  },
  personalFlag('tasks_default_locked', 'tasks_default_locked', 'tasks_default_locked must be a boolean.'),
  // Which quick-start templates the shift plan shows - like disabled_modules
  // household-wide and admin-only, not per user like hidden_modules: the
  // templates create shared shift types. Checked at the very top, before any
  // write of the request: the check once sat in the middle of the handler,
  // after other household fields had long been written - a mixed payload of a
  // non-admin was then partly applied before the 403 came. Since #1622 the
  // transaction around the handler takes such a patch back anyway; the check
  // stays first because it costs nothing. Written here, at its place.
  {
    field: 'schedule_hidden_templates',
    storage: ['schedule_hidden_templates'],
    scope: 'household',
    write: 'admin',
    early: 1,
    read: (ctx) => parseScheduleHiddenTemplates(ctx.get('schedule_hidden_templates')),
    check: (input) => (Array.isArray(input) ? null : invalid('schedule_hidden_templates must be an array.')),
    apply(input, ctx) {
      const unique = [...new Set((input as unknown[])
        .filter((key) => typeof key === 'string' && SCHEDULE_TEMPLATE_KEYS.includes(key)))];
      ctx.set('schedule_hidden_templates', JSON.stringify(unique));
      return null;
    },
  },
  // Three views on the cycle tab (#760), in the same pattern as `language`: what
  // the household allows, what I chose for myself, and what counts in the end.
  //
  // The admin switch is the household default; the personal opt-out can only make
  // it narrower, never wider. Hence AND instead of an override: who switches the
  // cycle off household-wide hides it for everybody, and nobody gets it back on
  // their own. A missing value = on, so existing accounts keep their behaviour.
  { ...householdFlag('health_cycle_enabled', 'admin', 'health_cycle_enabled must be a boolean', (v) => v !== '0'), scope: 'household-default' },
  // The personal opt-out (#760) - on purpose WITHOUT an admin gate: it touches
  // only one's own view, and the same mistake (a per-user value behind adminOnly)
  // once cost five of six family members their setting (critique 2026-07-27, see
  // calendar_default_reminders).
  {
    ...personalFlag('health_cycle_enabled_user', 'health_cycle_enabled', 'health_cycle_enabled_user must be a boolean'),
    read: (ctx) => ctx.own('health_cycle_enabled') !== '0',
  },
  {
    field: 'health_cycle_effective',
    storage: ['health_cycle_enabled', 'health_cycle_enabled' + USER],
    scope: 'household-default',
    write: 'none',
    read: (ctx) => ctx.get('health_cycle_enabled') !== '0' && ctx.own('health_cycle_enabled') !== '0',
  },
  // The caregiver fan-out of prevention reminders (D6/review #1256) - an opt-in
  // like cycle_settings.notify_partner_user_id: the owner publishes on purpose,
  // nothing shares by itself. Default off. Works at once: the same sync
  // caregivers.js starts after a change of care, not only the next periodic run.
  {
    ...personalFlag('health_prevention_notify_caregivers', 'health_prevention_notify_caregivers',
      'health_prevention_notify_caregivers must be a boolean'),
    apply(input, ctx) {
      if (typeof input !== 'boolean') return invalid('health_prevention_notify_caregivers must be a boolean');
      ctx.setOwn('health_prevention_notify_caregivers', input ? '1' : '0');
      ctx.effects.preventionCaregiversChanged(ctx.db, ctx.userId);
      return null;
    },
  },
  householdFlag('rewards_require_approval', 'admin', 'rewards_require_approval must be a boolean', (v) => v !== '0'),
  householdFlag('tasks_subtasks_expanded', 'admin', 'tasks_subtasks_expanded must be a boolean', (v) => v === '1'),
  // Shows who created each task in the list and card (#2451), admin-only.
  householdFlag('tasks_show_creator', 'admin', 'tasks_show_creator must be a boolean', (v) => v === '1'),
  // Default points for new tasks (#578). 0 switches the default off.
  {
    field: 'tasks_default_points',
    storage: ['tasks_default_points'],
    scope: 'household',
    write: 'admin',
    read: (ctx) => parseTaskDefaultPoints(ctx.get('tasks_default_points')),
    apply(input, ctx) {
      const points = Number(input);
      if (!Number.isInteger(points) || points < 0 || points > MAX_TASK_POINTS) {
        return invalid(`tasks_default_points must be an integer between 0 and ${MAX_TASK_POINTS}`);
      }
      ctx.set('tasks_default_points', String(points));
      return null;
    },
  },
  // Late-completion decay: one point less per overdue day, at least 1. Admin only,
  // default off - existing households book unchanged until somebody switches it on.
  householdFlag('tasks_late_decay_enabled', 'admin', 'tasks_late_decay_enabled must be a boolean', (v) => v === '1'),
  // Grace period for expired countdowns (#969). 0 = no grace period.
  {
    field: 'countdown_grace_days',
    storage: ['countdown_grace_days'],
    scope: 'household',
    write: 'admin',
    read: (ctx) => parseCountdownGraceDays(ctx.get('countdown_grace_days')),
    apply(input, ctx) {
      const days = Number(input);
      if (!Number.isInteger(days) || days < 0 || days > MAX_COUNTDOWN_GRACE_DAYS) {
        return invalid(`countdown_grace_days must be an integer between 0 and ${MAX_COUNTDOWN_GRACE_DAYS}`);
      }
      ctx.set('countdown_grace_days', String(days));
      return null;
    },
  },
  // The household's weather - admin only, ONE gate for the six fields (`gate`).
  // Each field can be overridden per account through `weather_user`.
  {
    field: 'weather_provider',
    storage: ['weather_provider'],
    scope: 'household-default',
    write: 'admin',
    gate: 'weather',
    read: (ctx) => ctx.get('weather_provider') ?? null,
    apply(input, ctx) {
      if (input !== null && !VALID_WEATHER_PROVIDERS.includes(input as string)) {
        return invalid(`Invalid provider. Allowed: ${VALID_WEATHER_PROVIDERS.join(', ')}`);
      }
      if (input === null) ctx.delete('weather_provider');
      else ctx.set('weather_provider', input);
      return null;
    },
  },
  // `null` deletes the household's coordinates. Without it they stayed when the
  // provider was removed, and the proxy kept taking them - the `.env` values never
  // came to bear again.
  {
    field: 'weather_lat',
    storage: ['weather_lat'],
    scope: 'household-default',
    write: 'admin',
    gate: 'weather',
    read: (ctx) => ctx.get('weather_lat') ?? null,
    apply(input, ctx) {
      if (input === null) { ctx.delete('weather_lat'); return null; }
      const v = latitude(input);
      if (v === null) return invalid('Invalid latitude (-90 to 90).');
      ctx.set('weather_lat', String(v));
      return null;
    },
  },
  {
    field: 'weather_lon',
    storage: ['weather_lon'],
    scope: 'household-default',
    write: 'admin',
    gate: 'weather',
    read: (ctx) => ctx.get('weather_lon') ?? null,
    apply(input, ctx) {
      if (input === null) { ctx.delete('weather_lon'); return null; }
      const v = longitude(input);
      if (v === null) return invalid('Invalid longitude (-180 to 180).');
      ctx.set('weather_lon', String(v));
      return null;
    },
  },
  {
    field: 'weather_city',
    storage: ['weather_city'],
    scope: 'household-default',
    write: 'admin',
    gate: 'weather',
    read: (ctx) => ctx.get('weather_city') ?? '',
    // `String(input)`: a `null` here stores the string "null" (held as today's
    // behaviour by test:settings-registry; the personal city deletes instead).
    apply(input, ctx) {
      const trimmed = String(input).slice(0, 100).trim();
      if (trimmed) ctx.set('weather_city', trimmed);
      else ctx.delete('weather_city');
      return null;
    },
  },
  {
    field: 'weather_units',
    storage: ['weather_units'],
    scope: 'household-default',
    write: 'admin',
    gate: 'weather',
    read: (ctx) => ctx.get('weather_units') ?? 'metric',
    apply(input, ctx) {
      if (!VALID_WEATHER_UNITS.includes(input as string)) return invalid(`Invalid unit. Allowed: ${VALID_WEATHER_UNITS.join(', ')}`);
      ctx.set('weather_units', input);
      return null;
    },
  },
  {
    field: 'weather_auto_locate',
    storage: ['weather_auto_locate'],
    scope: 'household-default',
    write: 'admin',
    gate: 'weather',
    read: (ctx) => ctx.get('weather_auto_locate') === '1',
    apply(input, ctx) {
      if (typeof input !== 'boolean') return invalid('weather_auto_locate must be a boolean.');
      ctx.set('weather_auto_locate', input ? '1' : '0');
      return null;
    },
  },
  // The personal weather override - writable by every signed-in account. Read
  // back as five fields, `null` per field = inherits the household's.
  {
    field: 'weather_user',
    storage: ['weather_lat', 'weather_lon', 'weather_city', 'weather_units', 'weather_auto_locate'].map((key) => key + USER),
    scope: 'personal',
    write: 'member',
    read: (ctx) => {
      const autoRaw = ctx.own('weather_auto_locate');
      return {
        lat: ctx.own('weather_lat'),
        lon: ctx.own('weather_lon'),
        city: ctx.own('weather_city'),
        units: ctx.own('weather_units'),
        auto_locate: autoRaw === null ? null : autoRaw === '1',
      };
    },
    apply(input, ctx) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid('weather_user must be an object.');
      if (!ctx.userId) return { kind: 'unauthenticated' };
      const { lat, lon, city, units, auto_locate: autoLocate } = input as Record<string, unknown>;
      if (lat !== undefined) {
        if (lat === null) ctx.deleteOwn('weather_lat');
        else {
          const v = latitude(lat);
          if (v === null) return invalid('Invalid latitude (-90 to 90).');
          ctx.setOwn('weather_lat', String(v));
        }
      }
      if (lon !== undefined) {
        if (lon === null) ctx.deleteOwn('weather_lon');
        else {
          const v = longitude(lon);
          if (v === null) return invalid('Invalid longitude (-180 to 180).');
          ctx.setOwn('weather_lon', String(v));
        }
      }
      if (city !== undefined) {
        const trimmed = city === null ? '' : String(city).slice(0, 100).trim();
        if (trimmed) ctx.setOwn('weather_city', trimmed);
        else ctx.deleteOwn('weather_city');
      }
      if (units !== undefined) {
        if (units === null) ctx.deleteOwn('weather_units');
        else {
          if (!VALID_WEATHER_UNITS.includes(units as string)) return invalid(`Invalid unit. Allowed: ${VALID_WEATHER_UNITS.join(', ')}`);
          ctx.setOwn('weather_units', units);
        }
      }
      if (autoLocate !== undefined) {
        if (autoLocate === null) ctx.deleteOwn('weather_auto_locate');
        else {
          if (typeof autoLocate !== 'boolean') return invalid('weather_user.auto_locate must be a boolean.');
          ctx.setOwn('weather_auto_locate', autoLocate ? '1' : '0');
        }
      }
      return null;
    },
  },
  // Holidays - admin only, ONE gate for the seven fields (`gate`).
  {
    field: 'holiday_country',
    storage: ['holiday_country', 'holiday_subdivision', 'holiday_group'],
    scope: 'household',
    write: 'admin',
    gate: 'holidays',
    read: (ctx) => ctx.get('holiday_country') ?? null,
    apply(input, ctx) {
      if (input !== null && !COUNTRY_ISO_RE.test(input as string)) {
        return invalid('Invalid country code (2 capital letters, e.g. DE).');
      }
      if (input === null) {
        ctx.delete('holiday_country');
        ctx.delete('holiday_subdivision');
        ctx.delete('holiday_group');
        return null;
      }
      // Another country without a group sent along: the stored one belongs to the
      // old country (BE-FR) and must not filter the new one (review of PR #1186).
      // Only the group goes; a stored subdivision of the old country stays (held as
      // today's behaviour by test:settings-registry).
      if (ctx.patch.holiday_group === undefined && ctx.get('holiday_country') !== input) ctx.delete('holiday_group');
      ctx.set('holiday_country', input);
      return null;
    },
  },
  {
    field: 'holiday_subdivision',
    storage: ['holiday_subdivision', 'holiday_group'],
    scope: 'household',
    write: 'admin',
    gate: 'holidays',
    read: (ctx) => ctx.get('holiday_subdivision') ?? null,
    apply(input, ctx) {
      if (input !== null && !SUBDIVISION_RE.test(input as string)) return invalid('Invalid region code (e.g. DE-BY).');
      // When a stored subdivision is removed, its school-holiday group goes with it
      // (CH-BE-VS belongs to CH-BE). Was none stored, a stored group belongs to the
      // country itself (BE-FR, D#1182) and stays: else a partial update with only
      // `holiday_subdivision: null` would delete the chosen community silently
      // (review of PR #1186).
      if (input === null) {
        const hadSubdivision = ctx.get('holiday_subdivision') != null;
        ctx.delete('holiday_subdivision');
        if (hadSubdivision) ctx.delete('holiday_group');
      } else {
        ctx.set('holiday_subdivision', input);
      }
      return null;
    },
  },
  // The school-holiday group (e.g. CH-BE-VS) of multilingual cantons. Uses the
  // grammar of a region code. NULL/empty = no group chosen. (#434)
  {
    field: 'holiday_group',
    storage: ['holiday_group'],
    scope: 'household',
    write: 'admin',
    gate: 'holidays',
    read: (ctx) => ctx.get('holiday_group') ?? null,
    apply(input, ctx) {
      if (input !== null && input !== '' && !SUBDIVISION_RE.test(input as string)) {
        return invalid('Invalid group code (e.g. CH-BE-VS).');
      }
      if (input === null || input === '') ctx.delete('holiday_group');
      else ctx.set('holiday_group', input);
      return null;
    },
  },
  { ...householdFlag('holiday_show_public', 'admin', 'holiday_show_public must be a boolean.', (v) => v === '1'), gate: 'holidays' },
  { ...householdFlag('holiday_show_school', 'admin', 'holiday_show_school must be a boolean.', (v) => v === '1'), gate: 'holidays' },
  {
    field: 'holiday_public_color',
    storage: ['holiday_public_color'],
    scope: 'household',
    write: 'admin',
    gate: 'holidays',
    read: (ctx) => ctx.get('holiday_public_color') ?? '#FF3B30',
    apply(input, ctx) {
      if (!HEX_COLOR_RE.test(input as string)) return invalid('holiday_public_color must be a valid hex color (e.g. #FF3B30).');
      ctx.set('holiday_public_color', input);
      return null;
    },
  },
  {
    field: 'holiday_school_color',
    storage: ['holiday_school_color'],
    scope: 'household',
    write: 'admin',
    gate: 'holidays',
    read: (ctx) => ctx.get('holiday_school_color') ?? '#34C759',
    apply(input, ctx) {
      if (!HEX_COLOR_RE.test(input as string)) return invalid('holiday_school_color must be a valid hex color (e.g. #34C759).');
      ctx.set('holiday_school_color', input);
      return null;
    },
  },
  {
    // Written by services/holidays.js after a sync, read here only.
    field: 'holiday_last_sync',
    storage: ['holiday_last_sync'],
    scope: 'household',
    write: 'none',
    read: (ctx) => ctx.get('holiday_last_sync') ?? null,
  },
];

/** The order of the fields in the answer of GET and PUT (unchanged since before C3). */
const ANSWER_ORDER = [
  'visible_meal_types', 'meal_type_names', 'currency', 'date_format', 'time_format', 'week_start',
  'region', 'timezone', 'timezone_effective', 'timezone_hint_dismissed',
  'language', 'language_effective', 'language_auto', 'app_name',
  'dashboard_widgets', 'dashboard_today_glance', 'dashboard_widgets_default', 'dashboard_today_glance_default',
  'dashboard_follows_default', 'dashboard_widgets_phone', 'dashboard_follows_phone_default',
  'disabled_modules', 'hidden_modules', 'module_order', 'mobile_nav_order',
  'housekeeping_payment_tasks', 'budget_mode', 'calendar_default_duration',
  'calendar_default_reminders', 'calendar_default_assign_me', 'calendar_default_target',
  'health_cycle_enabled', 'health_cycle_enabled_user', 'health_cycle_effective',
  'health_prevention_notify_caregivers', 'rewards_require_approval', 'tasks_subtasks_expanded',
  'tasks_show_creator', 'tasks_default_points', 'countdown_grace_days', 'tasks_late_decay_enabled',
  'tasks_default_target', 'tasks_default_visibility', 'tasks_default_locked', 'schedule_hidden_templates',
  'weather_provider', 'weather_lat', 'weather_lon', 'weather_city', 'weather_units', 'weather_auto_locate',
  'weather_user',
  'holiday_country', 'holiday_subdivision', 'holiday_group', 'holiday_show_public', 'holiday_show_school',
  'holiday_public_color', 'holiday_school_color', 'holiday_last_sync',
];

const BY_FIELD = new Map(ENTRIES.map((entry) => [entry.field, entry]));
const EARLY_ENTRIES = ENTRIES.filter((entry) => entry.early).sort((a, b) => (a.early ?? 0) - (b.early ?? 0));
const ANSWER_ENTRIES = ANSWER_ORDER.map((field) => BY_FIELD.get(field) as Entry);

// The two lists name the same fields once each - checked on load, so a new entry
// without its place in the answer cannot start.
if (BY_FIELD.size !== ENTRIES.length || ANSWER_ORDER.length !== ENTRIES.length
  || ANSWER_ENTRIES.some((entry) => !entry)) {
  throw new Error('settings registry: ENTRIES and ANSWER_ORDER must name the same fields once each');
}

const CATALOG: readonly CatalogEntry[] = Object.freeze(ENTRIES.map((entry) => Object.freeze({
  field: entry.field,
  storage: Object.freeze([...entry.storage]),
  scope: entry.scope,
  write: entry.write,
  ...(entry.gate ? { gate: entry.gate } : {}),
  ...(entry.early ? { early: entry.early } : {}),
})));

// --------------------------------------------------------------------------
// The interface
// --------------------------------------------------------------------------

/**
 * Every setting as the answer of GET and PUT carries it, in the answer's order,
 * with defaults and normalisation. Without the views the route adds (weather
 * source, screensaver, display device settings) and without the route's
 * note-category filter on the two widget layouts.
 */
export function readSettings(db: SettingsDatabase, userId: number | null): Record<string, unknown> {
  const ctx = readContext(db, userId);
  const out: Record<string, unknown> = {};
  for (const entry of ANSWER_ENTRIES) out[entry.field] = entry.read(ctx);
  return out;
}

/** One setting as readSettings answers it - for a service (cycle reminders). */
export function readSetting(db: SettingsDatabase, field: string, userId: number | null = null): unknown {
  const entry = BY_FIELD.get(field);
  if (!entry) throw new Error(`settings registry: unknown field ${field}`);
  return entry.read(readContext(db, userId));
}

/**
 * Checks and writes a patch in the order of the registry; the first refusal wins
 * and the caller rolls the patch back. `null` = every field written.
 */
export function writeSettings(db: SettingsDatabase, actor: Actor, patch: unknown, effects: Effects): Refusal | null {
  const fields = patch as Record<string, unknown>;
  const ctx = writeContext(db, actor.userId, fields, effects);
  const mayManage = () => authorize(actor, 'manage', { household: true }).allowed;
  for (const entry of EARLY_ENTRIES) {
    if (fields[entry.field] === undefined) continue;
    if (entry.write === 'admin' && !mayManage()) return { kind: 'forbidden' };
    const refusal = entry.check?.(fields[entry.field], ctx) ?? null;
    if (refusal) return refusal;
  }
  for (const entry of ENTRIES) {
    const input = fields[entry.field];
    if (!entry.apply || input === undefined) continue;
    if (!entry.early && entry.write === 'admin' && !mayManage()) return { kind: 'forbidden' };
    const refusal = entry.apply(input, ctx);
    if (refusal) return refusal;
  }
  return null;
}

/** Per field: storage keys, scope, write right (and the shared gate, the early check). */
export function settingsCatalog(): readonly CatalogEntry[] {
  return CATALOG;
}
