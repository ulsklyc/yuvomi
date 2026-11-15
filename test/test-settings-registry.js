/**
 * Test: Settings registry - what GET and PUT /api/v1/preferences answer today (phase 2, C3)
 * Purpose: C3 moves the settings of server/routes/preferences.js into one
 *          registry. It is a refactor: no answer may change. This suite holds
 *          today's behaviour of the route as DATA, measured over the REAL
 *          server (test/server-ready.js) with session, CSRF and the /api/v1
 *          gate chain, so that every deviation of the refactor shows:
 *
 *          1. GET, the whole body (deepEqual), for an admin, a member and a
 *             paired wall display, on four states: fresh (every default), a
 *             seed that sets EVERY storage key of the route with a valid value
 *             (household and personal, the fossils `dashboard_widgets`,
 *             `dashboard_today_glance` and `module_order` household-wide
 *             included), a seed with stored values the read side falls back
 *             on (wrong enum, broken JSON, wrong type), and a seed with only
 *             the fallback stages (fossils, region-derived language).
 *          2. PUT, every case once as admin and once as member: the status,
 *             the whole body (a 200 as "the empty-patch answer of that role
 *             plus these fields", so a missing or extra field is red as well)
 *             and the `sync_config` rows the request wrote or deleted (keys of
 *             an account written as `<key>:user:<role>`). Every 400 text word
 *             for word; every admin field's 403 for a member, with no row
 *             written.
 *          3. Order: mixed patches with two refusals - which one wins today -
 *             and "whole patch or nothing": a refused patch leaves no row.
 *          4. Side effects: the household zone re-keys a series' exceptions
 *             and linked occurrences and sets the hint flag; the holiday keys
 *             delete their dependants (in the PUT cases, with seeds).
 *          5. The two other side effects by what they do: `disabled_modules`
 *             re-syncs the fasting reminders when health changes (and only
 *             then), `health_prevention_notify_caregivers` syncs the person's
 *             prevention reminders, and a failing sync there is only logged.
 *
 *          The expected values live in test/settings-registry-expected.json.
 *          They were recorded from the unchanged route (commit b7a78addd) and
 *          reviewed by hand; the refactor must not touch them. A case without
 *          an expectation is red.
 *
 *          Not reachable over the real server: `weather_user` without an
 *          account (401) - requireAuth answers before the route.
 *
 *          TODAY'S ODDITIES ARE HELD, NOT FIXED (a refactor keeps them; a fix
 *          is its own PR with its own row change here):
 *          - PUT `visible_meal_types` keeps duplicates ("dinner,breakfast,dinner").
 *          - PUT `weather_city: null` stores the string "null" (household).
 *          - PUT `holiday_country` with a new country keeps the stored
 *            subdivision of the old one (only the group is deleted).
 *          - PUT `calendar_default_assign_me` takes any value (truthy -> '1').
 *          - GET returns some stored values unchecked: `currency`, `timezone`,
 *            `tasks_default_visibility`, the household weather and holiday
 *            fields; `visible_meal_types` can be [] from a stored value.
 * Run: npm run test:settings-registry
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startTestServer, cookieHeader } from './server-ready.js';
import EXPECTED_JSON from './settings-registry-expected.json' with { type: 'json' };

/** @type {any} Recorded answers, read by case name and role. */
const EXPECTED = EXPECTED_JSON;

const { baseUrl: BASE } = await startTestServer({
  name: 'settings-registry',
  env: {
    SESSION_SECRET: 'test-settings-registry-secret-32-chars',
    DB_PATH: ':memory:',
    // timezone_effective falls back to TZ; pinned like DB_PATH.
    TZ: 'UTC',
    // Nothing from a developer's .env may reach the answers: weather_source
    // and screensaver_enabled read these.
    IMMICH_URL: '', IMMICH_API_KEY: '', IMMICH_SCREENSAVER_ALBUM_ID: '',
    WEATHER_LAT: '', WEATHER_LON: '', WEATHER_CITY: '', WEATHER_UNITS: '',
    OPENWEATHER_API_KEY: '', OPENWEATHER_CITY: '', OPENWEATHER_UNITS: '',
    MS_CLIENT_ID: '', MS_CLIENT_SECRET: '', MS_REDIRECT_URI: '',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: '',
  },
});

const db = (await import('../server/db.js')).get();
const { DISPLAY_COOKIE, issuePairingCode, redeemPairingCode } = await import('../server/services/display-accounts.js');
const { hashPassword } = await import('../server/utils/password.js');
const { expandAndResolveEventRows } = await import('../server/services/calendar-event-reader.js');
const { deleteOccurrence, upsertOccurrenceOverride } = await import('../server/services/calendar-occurrence-overrides.js');
const { readSetting, readSettings, settingsCatalog, writeSettings } = await import('../server/settings/registry.ts');

// --------------------------------------------------------------------------
// HTTP: one client address per request (the limiters key on it), a timeout
// --------------------------------------------------------------------------

let address = 0;
/**
 * @param {string} method
 * @param {string} path
 * @param {{ headers?: Record<string, string>, body?: unknown }} [options]
 */
async function http(method, path, { headers = {}, body } = {}) {
  address += 1;
  const xff = `10.37.${Math.floor(address / 250) % 250}.${(address % 250) + 1}`;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'X-Forwarded-For': xff, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  } catch (err) {
    return { status: `no answer (${/** @type {Error} */ (err).name})`, body: null, headers: null };
  }
}

// --------------------------------------------------------------------------
// Accounts: admin (setup), member (database + login), wall display (paired)
// --------------------------------------------------------------------------

const setup = await http('POST', '/api/v1/auth/setup', {
  body: { username: 'admin', display_name: 'Admin', password: 'admin-pass-123' },
});
assert.equal(setup.status, 201, `household setup: ${JSON.stringify(setup.body)}`);

/** @param {string} username @param {string} password */
async function login(username, password) {
  const res = await http('POST', '/api/v1/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, `login ${username}: ${JSON.stringify(res.body)}`);
  return { Cookie: cookieHeader(res.headers?.get('set-cookie')), 'X-CSRF-Token': res.body.csrfToken };
}

const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
const memberId = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('member', 'Member', ?, 'member', 'parent') RETURNING id
`).get(await hashPassword('member-pass-123')).id;
const displayId = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('wall', 'Wall', ?, 'member') RETURNING id
`).get(await hashPassword('wall-pass-123')).id;
db.prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(displayId, adminId);
const paired = redeemPairingCode(issuePairingCode(displayId, adminId).code);
assert.ok(paired?.token, 'the display is paired');

/** @type {Record<string, Record<string, string>>} */
const HEADERS = {
  admin: await login('admin', 'admin-pass-123'),
  member: await login('member', 'member-pass-123'),
  display: { Cookie: `${DISPLAY_COOKIE}=${encodeURIComponent(paired.token)}` },
};
/** @type {Record<string, number>} */
const USER_IDS = { admin: adminId, member: memberId, display: displayId };

// Note categories for the notes widget's category filter: one of the
// household, one personal to the admin (the member and the display do not see
// it), and the id 99999 that does not exist.
const householdCategory = Number(db.prepare(`
  INSERT INTO note_categories (name, name_key, scope, owner_user_id, created_by)
  VALUES ('Haushalt', 'haushalt', 'household', NULL, ?) RETURNING id
`).get(adminId).id);
const adminCategory = Number(db.prepare(`
  INSERT INTO note_categories (name, name_key, scope, owner_user_id, created_by)
  VALUES ('Privat', 'privat', 'personal', ?, ?) RETURNING id
`).get(adminId, adminId).id);

// --------------------------------------------------------------------------
// sync_config: snapshot, restore, seed, diff
// --------------------------------------------------------------------------

/** @returns {Record<string, string>} */
function snapshot() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM sync_config ORDER BY key').all()
    .map((/** @type {any} */ row) => [row.key, row.value]));
}

const upsert = db.prepare(`
  INSERT INTO sync_config (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const remove = db.prepare('DELETE FROM sync_config WHERE key = ?');

// What the server wrote on its own before the first case (setup, login,
// secrets). Every case starts from exactly this state.
const BASELINE = snapshot();

function restore() {
  for (const key of Object.keys(snapshot())) if (!(key in BASELINE)) remove.run(key);
  for (const [key, value] of Object.entries(BASELINE)) upsert.run(key, value);
  db.prepare('UPDATE display_accounts SET device_settings = NULL, show_screensaver = 0').run();
}

const ID_LABELS = Object.fromEntries(Object.entries(USER_IDS).map(([label, id]) => [String(id), label]));

/**
 * `<key>:user:<role>` (or `:user:self` for the acting role) to the stored key.
 * @param {string} key @param {string} self
 */
function storedKey(key, self) {
  return key.replace(/:user:([a-z]+)$/, (/** @type {string} */ _, /** @type {string} */ label) => `:user:${USER_IDS[label === 'self' ? self : label]}`);
}

/** The stored key back to `<key>:user:<role>`. @param {string} key */
function labelledKey(key) {
  return key.replace(/:user:(\d+)$/, (/** @type {string} */ _, /** @type {string} */ id) => `:user:${ID_LABELS[id] ?? id}`);
}

/** @param {Record<string, string | null>} seed @param {string} self */
function applySeed(seed, self) {
  for (const [key, value] of Object.entries(seed)) {
    if (value === null) remove.run(storedKey(key, self));
    else upsert.run(storedKey(key, self), value);
  }
}

/**
 * Rows written (new value) or deleted (null) between two snapshots.
 * @param {Record<string, string>} before @param {Record<string, string>} after
 */
function rowDiff(before, after) {
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    out[labelledKey(key)] = key in after ? after[key] : null;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// --------------------------------------------------------------------------
// 1. GET - four states, three roles, the whole body
// --------------------------------------------------------------------------

/**
 * Personal values of one account; `variant` keeps the three accounts apart.
 * @param {string} label @param {number} variant
 */
function personalValid(label, variant) {
  return {
    [`dashboard_widgets:user:${label}`]: JSON.stringify([
      { id: 'notes', visible: true, order: 0, size: '2x1', options: { categories: [adminCategory, householdCategory, 99999], limit: 5 } },
      { id: 'tasks', visible: variant !== 1, order: 1, size: '1x1' },
    ]),
    [`dashboard_today_glance:user:${label}`]: variant === 1 ? '1' : '0',
    [`dashboard_widgets_phone:user:${label}`]: JSON.stringify([
      { id: 'tasks', visible: true, order: 0 }, { id: 'notes', visible: false, order: 1 },
    ]),
    [`hidden_modules:user:${label}`]: variant === 1 ? '["notes","budget"]' : '["notes"]',
    [`module_order:user:${label}`]: variant === 1 ? '["dashboard","tasks"]' : '["tasks","dashboard"]',
    [`mobile_nav_order:user:${label}`]: '["tasks","kitchen","notes"]',
    [`calendar_default_reminders:user:${label}`]: '[60,15]',
    [`calendar_default_assign_me:user:${label}`]: '1',
    [`calendar_default_target:user:${label}`]: 'google:primary',
    [`tasks_default_target:user:${label}`]: 'caldav:1|https://dav.example/c/',
    [`tasks_default_visibility:user:${label}`]: variant === 1 ? 'assignees' : 'private',
    [`tasks_default_locked:user:${label}`]: '1',
    [`health_cycle_enabled:user:${label}`]: variant === 1 ? '0' : '1',
    [`health_prevention_notify_caregivers:user:${label}`]: '1',
    [`weather_lat:user:${label}`]: '48.1',
    [`weather_lon:user:${label}`]: '11.5',
    [`weather_city:user:${label}`]: variant === 1 ? 'Augsburg' : 'Muenchen',
    [`weather_units:user:${label}`]: 'metric',
    [`weather_auto_locate:user:${label}`]: variant === 1 ? '1' : '0',
  };
}

/** @param {string} label */
function personalInvalid(label) {
  return {
    [`dashboard_widgets:user:${label}`]: '[{"id":"Bad Id"}]',
    [`dashboard_today_glance:user:${label}`]: 'x',
    [`dashboard_widgets_phone:user:${label}`]: '{broken',
    [`hidden_modules:user:${label}`]: '["dashboard","settings","notes"]',
    [`module_order:user:${label}`]: 'null',
    [`mobile_nav_order:user:${label}`]: '[1,2,"bogus"]',
    [`calendar_default_reminders:user:${label}`]: '[7,"60",60]',
    [`calendar_default_assign_me:user:${label}`]: 'true',
    [`calendar_default_target:user:${label}`]: '',
    [`tasks_default_target:user:${label}`]: '',
    [`tasks_default_visibility:user:${label}`]: 'nobody',
    [`tasks_default_locked:user:${label}`]: 'true',
    [`health_cycle_enabled:user:${label}`]: 'off',
    [`health_prevention_notify_caregivers:user:${label}`]: 'true',
    [`weather_lat:user:${label}`]: 'x',
    [`weather_lon:user:${label}`]: '',
    [`weather_city:user:${label}`]: '',
    [`weather_units:user:${label}`]: 'kelvin',
    [`weather_auto_locate:user:${label}`]: 'yes',
  };
}

/** @type {Record<string, { seed: Record<string, string>, display: { showScreensaver: number, deviceSettings: string } | null }>} */
const GET_STATES = {
  fresh: { seed: {}, display: null },
  valid: {
    seed: {
      visible_meal_types: 'dinner,lunch',
      meal_type_names: '{"lunch":"Zmittag","snack":"Znueni, spaet"}',
      currency: 'CHF',
      date_format: 'ymd_dot',
      time_format: '12h',
      week_start: 'saturday',
      region: 'de-CH',
      household_timezone: 'Europe/Zurich',
      household_timezone_hint_dismissed: '1',
      language: 'fr',
      app_name: 'Haus Sonnenberg',
      dashboard_widgets_default: JSON.stringify([
        { id: 'tasks', visible: true, order: 0, size: '2x2' },
        { id: 'notes', visible: true, order: 1, size: '1x1', options: { categories: [householdCategory, adminCategory, 99999] } },
      ]),
      dashboard_today_glance_default: '0',
      dashboard_widgets: '[{"id":"calendar","visible":true,"order":0,"size":"1x1"}]',
      dashboard_today_glance: '1',
      module_order: '["calendar","tasks"]',
      disabled_modules: '["budget","health"]',
      housekeeping_payment_tasks: '1',
      budget_mode: 'personal',
      calendar_default_duration: '45',
      health_cycle_enabled: '0',
      rewards_require_approval: '0',
      tasks_subtasks_expanded: '1',
      tasks_default_points: '15',
      tasks_late_decay_enabled: '1',
      countdown_grace_days: '0',
      schedule_hidden_templates: '["school","university"]',
      weather_provider: 'open-meteo',
      weather_lat: '47.37',
      weather_lon: '8.54',
      weather_city: 'Zuerich',
      weather_units: 'imperial',
      weather_auto_locate: '1',
      holiday_country: 'CH',
      holiday_subdivision: 'CH-BE',
      holiday_group: 'CH-BE-VS',
      holiday_show_public: '1',
      holiday_show_school: '1',
      holiday_public_color: '#112233',
      holiday_school_color: '#445566',
      holiday_last_sync: '2035-01-02T03:04:05Z',
      // Not keys of the route, but screensaver_enabled reads them.
      immich_url: 'https://immich.example',
      immich_api_key: 'test-key',
      ...personalValid('admin', 0),
      ...personalValid('member', 1),
      ...personalValid('display', 2),
    },
    display: { showScreensaver: 1, deviceSettings: '{"night_from":21,"night_until":7,"idle_seconds":600,"show_clock":false,"cover_photo":true}' },
  },
  invalid: {
    seed: {
      visible_meal_types: 'brunch,,nope',
      meal_type_names: '{broken',
      currency: 'XYZ',
      date_format: 'iso',
      time_format: '13h',
      week_start: 'friday',
      region: '',
      household_timezone: 'Mars/Base',
      household_timezone_hint_dismissed: 'yes',
      language: 'xx',
      app_name: '',
      dashboard_widgets_default: '{broken',
      dashboard_today_glance_default: 'x',
      dashboard_widgets: 'not json',
      dashboard_today_glance: '0',
      module_order: '{}',
      disabled_modules: '{broken',
      housekeeping_payment_tasks: 'true',
      budget_mode: 'both',
      calendar_default_duration: 'abc',
      health_cycle_enabled: 'no',
      rewards_require_approval: '',
      tasks_subtasks_expanded: 'true',
      tasks_default_points: '-5',
      tasks_late_decay_enabled: 'x',
      countdown_grace_days: '500',
      schedule_hidden_templates: '"work"',
      weather_provider: 'darksky',
      weather_lat: 'north',
      weather_lon: '',
      weather_city: '',
      weather_units: 'kelvin',
      weather_auto_locate: 'true',
      holiday_country: 'germany',
      holiday_subdivision: '',
      holiday_group: '',
      holiday_show_public: 'yes',
      holiday_show_school: '',
      holiday_public_color: 'red',
      holiday_school_color: '',
      holiday_last_sync: '',
      ...personalInvalid('admin'),
      ...personalInvalid('member'),
      ...personalInvalid('display'),
    },
    display: { showScreensaver: 0, deviceSettings: '{"night_from":25}' },
  },
  fallback: {
    // Only the last stages: household fossils, no default, nothing personal;
    // the language derived from the region; a second-stage widget meal list.
    seed: {
      dashboard_widgets: '[{"id":"calendar","visible":false,"order":3,"size":"2x1"},{"id":"tasks","order":1}]',
      dashboard_today_glance: '0',
      module_order: '["calendar","tasks","bogus","calendar"]',
      region: 'fr-CA',
      weather_lat: '50',
      weather_lon: '7',
      tasks_default_points: '20000',
      countdown_grace_days: '3.9',
      calendar_default_duration: '0',
      'health_cycle_enabled:user:member': '0',
    },
    display: null,
  },
};

// Every storage key the route reads or writes. The valid and the invalid seed
// set each of them (personal keys for all three accounts).
const HOUSEHOLD_KEYS = [
  'visible_meal_types', 'meal_type_names', 'currency', 'date_format', 'time_format', 'week_start',
  'region', 'household_timezone', 'household_timezone_hint_dismissed', 'language', 'app_name',
  'dashboard_widgets_default', 'dashboard_today_glance_default',
  'dashboard_widgets', 'dashboard_today_glance', 'module_order', // fossils, household-wide last stage
  'disabled_modules', 'housekeeping_payment_tasks', 'budget_mode', 'calendar_default_duration',
  'health_cycle_enabled', 'rewards_require_approval', 'tasks_subtasks_expanded', 'tasks_default_points',
  'tasks_late_decay_enabled', 'countdown_grace_days', 'schedule_hidden_templates',
  'weather_provider', 'weather_lat', 'weather_lon', 'weather_city', 'weather_units', 'weather_auto_locate',
  'holiday_country', 'holiday_subdivision', 'holiday_group', 'holiday_show_public', 'holiday_show_school',
  'holiday_public_color', 'holiday_school_color', 'holiday_last_sync',
];
const PERSONAL_KEYS = Object.keys(personalValid('x', 0)).map((key) => key.replace(/:user:x$/, ''));

test('the valid and the invalid GET seed set every storage key of the route', () => {
  assert.equal(HOUSEHOLD_KEYS.length, 41);
  assert.equal(PERSONAL_KEYS.length, 19);
  for (const state of ['valid', 'invalid']) {
    const keys = Object.keys(GET_STATES[state].seed);
    assert.deepEqual(HOUSEHOLD_KEYS.filter((key) => !keys.includes(key)), [], `${state}: household`);
    for (const label of ['admin', 'member', 'display']) {
      assert.deepEqual(PERSONAL_KEYS.filter((key) => !keys.includes(`${key}:user:${label}`)), [], `${state}: ${label}`);
    }
  }
});

for (const [state, { seed, display }] of Object.entries(GET_STATES)) {
  for (const role of ['admin', 'member', 'display']) {
    test(`GET / on the ${state} state as ${role}: the whole body`, async () => {
      restore();
      applySeed(seed, role);
      if (display) {
        db.prepare('UPDATE display_accounts SET show_screensaver = ?, device_settings = ? WHERE user_id = ?')
          .run(display.showScreensaver, display.deviceSettings, displayId);
      }
      const before = snapshot();
      const res = await http('GET', '/api/v1/preferences', { headers: HEADERS[role] });
      const actual = { status: res.status, body: res.body };
      assert.deepEqual(actual, EXPECTED.get?.[state]?.[role], `GET ${state} ${role}`);
      assert.deepEqual(rowDiff(before, snapshot()), {}, 'GET writes no sync_config row');
    });
  }
}

// --------------------------------------------------------------------------
// 2. and 3. PUT - every case as admin and as member
// --------------------------------------------------------------------------

const LONG_41 = 'x'.repeat(41);
const WIDGETS = [
  { id: 'tasks', size: '2x1' },
  { id: 'notes', visible: false, options: { categories: [0, 99999], flag: true, label: 'a' } },
  { id: 'calendar', order: -1 },
];

/**
 * One PUT case: a name, the body, and optionally a seed (`:user:self` is the
 * acting account). Every case runs for the admin and for the member.
 * @type {Array<{ name: string, body: unknown, seed?: Record<string, string | null> }>}
 */
const PUT_CASES = [
  // --- the empty patch and patches the route does not know ------------------
  { name: 'empty patch', body: {} },
  { name: 'unknown field only', body: { not_a_setting: 1, __proto__x: 2 } },
  { name: 'array body', body: [] },

  // --- schedule_hidden_templates (checked first, written later) -------------
  { name: 'schedule_hidden_templates valid', body: { schedule_hidden_templates: ['school', 'bogus', 'school', 7] } },
  { name: 'schedule_hidden_templates empty', body: { schedule_hidden_templates: [] }, seed: { schedule_hidden_templates: '["work"]' } },
  { name: 'schedule_hidden_templates not an array', body: { schedule_hidden_templates: 'work' } },

  // --- timezone_hint_dismissed (checked first, written later) ---------------
  { name: 'timezone_hint_dismissed true', body: { timezone_hint_dismissed: true } },
  { name: 'timezone_hint_dismissed false', body: { timezone_hint_dismissed: false }, seed: { household_timezone_hint_dismissed: '1' } },
  { name: 'timezone_hint_dismissed not boolean', body: { timezone_hint_dismissed: 'yes' } },

  // --- visible_meal_types ---------------------------------------------------
  { name: 'visible_meal_types valid', body: { visible_meal_types: ['dinner', 'breakfast', 'nope', 'dinner'] } },
  { name: 'visible_meal_types not an array', body: { visible_meal_types: 'breakfast' } },
  { name: 'visible_meal_types empty after filter', body: { visible_meal_types: ['nope'] } },

  // --- meal_type_names ------------------------------------------------------
  { name: 'meal_type_names valid', body: { meal_type_names: { lunch: '  Zmittag  ', snack: 'Znueni, spaet', brunch: 'Elf', dinner: '', breakfast: null } } },
  { name: 'meal_type_names null', body: { meal_type_names: null }, seed: { meal_type_names: '{"lunch":"Z"}' } },
  { name: 'meal_type_names empty object', body: { meal_type_names: {} }, seed: { meal_type_names: '{"lunch":"Z"}' } },
  { name: 'meal_type_names 40 characters', body: { meal_type_names: { lunch: 'x'.repeat(40) } } },
  { name: 'meal_type_names string', body: { meal_type_names: 'Zmittag' } },
  { name: 'meal_type_names array', body: { meal_type_names: ['Zmittag'] } },
  { name: 'meal_type_names value not a string', body: { meal_type_names: { lunch: 42 } } },
  { name: 'meal_type_names value too long', body: { meal_type_names: { lunch: LONG_41 } } },

  // --- currency, date_format, time_format, week_start ----------------------
  { name: 'currency valid', body: { currency: 'CHF' } },
  { name: 'currency invalid', body: { currency: 'XYZ' } },
  { name: 'date_format valid', body: { date_format: 'ymd_slash' } },
  { name: 'date_format invalid', body: { date_format: 'iso' } },
  { name: 'time_format valid', body: { time_format: '12h' } },
  { name: 'time_format invalid', body: { time_format: '13h' } },
  { name: 'week_start valid', body: { week_start: 'sunday' } },
  { name: 'week_start invalid', body: { week_start: 'friday' } },

  // --- budget_mode, region, timezone, language, app_name --------------------
  { name: 'budget_mode valid', body: { budget_mode: 'personal' } },
  { name: 'budget_mode invalid', body: { budget_mode: 'both' } },
  { name: 'region valid', body: { region: 'fr-CA' } },
  { name: 'region custom', body: { region: 'custom' } },
  { name: 'region null', body: { region: null }, seed: { region: 'de-DE' } },
  { name: 'region invalid', body: { region: 'not a region!' } },
  { name: 'timezone valid', body: { timezone: 'America/New_York' } },
  { name: 'timezone null', body: { timezone: null }, seed: { household_timezone: 'Europe/Berlin' } },
  { name: 'timezone empty string', body: { timezone: '' }, seed: { household_timezone: 'Europe/Berlin' } },
  { name: 'timezone invalid', body: { timezone: 'Mars/Base' } },
  { name: 'language valid', body: { language: 'de' } },
  { name: 'language null', body: { language: null }, seed: { language: 'fr' } },
  { name: 'language empty string', body: { language: '' }, seed: { language: 'fr' } },
  { name: 'language invalid', body: { language: 'xx' } },
  { name: 'app_name valid', body: { app_name: '  Haus  ' } },
  { name: 'app_name empty', body: { app_name: '' }, seed: { app_name: 'Alt' } },
  { name: 'app_name null', body: { app_name: null }, seed: { app_name: 'Alt' } },
  { name: 'app_name too long', body: { app_name: 'x'.repeat(101) } },
  { name: 'app_name not a string', body: { app_name: 42 } },

  // --- dashboard (personal, household default) ------------------------------
  { name: 'dashboard_widgets valid', body: { dashboard_widgets: WIDGETS } },
  { name: 'dashboard_widgets null', body: { dashboard_widgets: null }, seed: { 'dashboard_widgets:user:self': '[{"id":"tasks","visible":true,"order":0,"size":"1x1"}]' } },
  { name: 'dashboard_widgets not an array', body: { dashboard_widgets: 'x' } },
  { name: 'dashboard_widgets invalid entry', body: { dashboard_widgets: [{ id: 'Bad Id' }] } },
  { name: 'dashboard_widgets_phone valid', body: { dashboard_widgets_phone: WIDGETS } },
  { name: 'dashboard_widgets_phone null', body: { dashboard_widgets_phone: null }, seed: { 'dashboard_widgets_phone:user:self': '[{"id":"tasks","visible":true,"order":0}]' } },
  { name: 'dashboard_widgets_phone not an array', body: { dashboard_widgets_phone: 'x' } },
  { name: 'dashboard_widgets_phone invalid entry', body: { dashboard_widgets_phone: [{}] } },
  { name: 'dashboard_today_glance false', body: { dashboard_today_glance: false } },
  { name: 'dashboard_today_glance null', body: { dashboard_today_glance: null }, seed: { 'dashboard_today_glance:user:self': '0' } },
  { name: 'dashboard_today_glance not boolean', body: { dashboard_today_glance: 'x' } },
  { name: 'dashboard_widgets_default valid', body: { dashboard_widgets_default: WIDGETS } },
  { name: 'dashboard_widgets_default null', body: { dashboard_widgets_default: null }, seed: { dashboard_widgets_default: '[{"id":"tasks","visible":true,"order":0,"size":"1x1"}]' } },
  { name: 'dashboard_widgets_default not an array', body: { dashboard_widgets_default: 'x' } },
  { name: 'dashboard_widgets_default duplicate entry', body: { dashboard_widgets_default: [{ id: 'tasks' }, { id: 'tasks' }] } },
  { name: 'dashboard_today_glance_default false', body: { dashboard_today_glance_default: false } },
  { name: 'dashboard_today_glance_default null', body: { dashboard_today_glance_default: null }, seed: { dashboard_today_glance_default: '0' } },
  { name: 'dashboard_today_glance_default not boolean', body: { dashboard_today_glance_default: 'x' } },

  // --- modules and navigation -----------------------------------------------
  { name: 'disabled_modules valid', body: { disabled_modules: ['health', 'tasks', 'tasks', 'bogus', 'dashboard', 3] } },
  { name: 'disabled_modules not an array', body: { disabled_modules: 'health' } },
  { name: 'hidden_modules valid', body: { hidden_modules: ['budget', 'settings', 'budget'] } },
  { name: 'hidden_modules not an array', body: { hidden_modules: 'budget' } },
  { name: 'module_order valid', body: { module_order: ['tasks', 'dashboard', 'bogus', 'tasks', 'third-party-foo-bar'] } },
  { name: 'module_order not an array', body: { module_order: 'tasks' } },
  { name: 'mobile_nav_order valid', body: { mobile_nav_order: ['meals', 'recipes', 'tasks', 'calendar', 'notes'] } },
  { name: 'mobile_nav_order not an array', body: { mobile_nav_order: 'tasks' } },

  // --- household switches and numbers ---------------------------------------
  { name: 'housekeeping_payment_tasks true', body: { housekeeping_payment_tasks: true } },
  { name: 'housekeeping_payment_tasks not boolean', body: { housekeeping_payment_tasks: 'true' } },
  { name: 'calendar_default_duration valid', body: { calendar_default_duration: 90 } },
  { name: 'calendar_default_duration numeric string', body: { calendar_default_duration: '45' } },
  { name: 'calendar_default_duration too small', body: { calendar_default_duration: 4 } },
  { name: 'calendar_default_duration too large', body: { calendar_default_duration: 1441 } },
  { name: 'calendar_default_duration fraction', body: { calendar_default_duration: 5.5 } },
  { name: 'health_cycle_enabled false', body: { health_cycle_enabled: false } },
  { name: 'health_cycle_enabled not boolean', body: { health_cycle_enabled: 'x' } },
  { name: 'rewards_require_approval false', body: { rewards_require_approval: false } },
  { name: 'rewards_require_approval not boolean', body: { rewards_require_approval: 'x' } },
  { name: 'tasks_subtasks_expanded true', body: { tasks_subtasks_expanded: true } },
  { name: 'tasks_subtasks_expanded not boolean', body: { tasks_subtasks_expanded: 'x' } },
  { name: 'tasks_default_points valid', body: { tasks_default_points: '25' } },
  { name: 'tasks_default_points zero', body: { tasks_default_points: 0 } },
  { name: 'tasks_default_points negative', body: { tasks_default_points: -1 } },
  { name: 'tasks_default_points too large', body: { tasks_default_points: 10001 } },
  { name: 'tasks_late_decay_enabled true', body: { tasks_late_decay_enabled: true } },
  { name: 'tasks_late_decay_enabled not boolean', body: { tasks_late_decay_enabled: 'x' } },
  { name: 'countdown_grace_days zero', body: { countdown_grace_days: 0 } },
  { name: 'countdown_grace_days ninety', body: { countdown_grace_days: 90 } },
  { name: 'countdown_grace_days negative', body: { countdown_grace_days: -1 } },
  { name: 'countdown_grace_days too large', body: { countdown_grace_days: 91 } },

  // --- personal calendar and task defaults ----------------------------------
  { name: 'calendar_default_reminders valid', body: { calendar_default_reminders: [60, '15', 60] } },
  { name: 'calendar_default_reminders not an array', body: { calendar_default_reminders: 60 } },
  { name: 'calendar_default_reminders unknown offset', body: { calendar_default_reminders: [7] } },
  { name: 'calendar_default_reminders too many', body: { calendar_default_reminders: [0, 15, 60, 1440, 2880, 10080] } },
  { name: 'calendar_default_assign_me true', body: { calendar_default_assign_me: true } },
  { name: 'calendar_default_assign_me any truthy', body: { calendar_default_assign_me: 'no' } },
  { name: 'calendar_default_assign_me zero', body: { calendar_default_assign_me: 0 } },
  { name: 'calendar_default_target valid', body: { calendar_default_target: '  google:primary  ' } },
  { name: 'calendar_default_target null', body: { calendar_default_target: null }, seed: { 'calendar_default_target:user:self': 'google:primary' } },
  { name: 'calendar_default_target not a string', body: { calendar_default_target: 5 } },
  { name: 'calendar_default_target too long', body: { calendar_default_target: `google:${'x'.repeat(494)}` } },
  { name: 'calendar_default_target bad form', body: { calendar_default_target: 'bogus' } },
  { name: 'tasks_default_target valid', body: { tasks_default_target: 'caldav:1|https://dav.example/c/' } },
  { name: 'tasks_default_target empty', body: { tasks_default_target: '' }, seed: { 'tasks_default_target:user:self': 'caldav:1|https://dav.example/c/' } },
  { name: 'tasks_default_target not a string', body: { tasks_default_target: 5 } },
  { name: 'tasks_default_target too long', body: { tasks_default_target: 'x'.repeat(501) } },
  { name: 'tasks_default_target google', body: { tasks_default_target: 'google:primary' } },
  { name: 'tasks_default_target bad form', body: { tasks_default_target: 'bogus' } },
  { name: 'tasks_default_visibility valid', body: { tasks_default_visibility: 'private' } },
  { name: 'tasks_default_visibility invalid', body: { tasks_default_visibility: 'nobody' } },
  { name: 'tasks_default_locked true', body: { tasks_default_locked: true } },
  { name: 'tasks_default_locked not boolean', body: { tasks_default_locked: 'x' } },
  { name: 'health_cycle_enabled_user false', body: { health_cycle_enabled_user: false } },
  { name: 'health_cycle_enabled_user not boolean', body: { health_cycle_enabled_user: 'x' } },
  { name: 'health_prevention_notify_caregivers true', body: { health_prevention_notify_caregivers: true } },
  { name: 'health_prevention_notify_caregivers not boolean', body: { health_prevention_notify_caregivers: 'x' } },

  // --- household weather (one gate for six fields) --------------------------
  { name: 'weather_provider valid', body: { weather_provider: 'openweathermap' } },
  { name: 'weather_provider null', body: { weather_provider: null }, seed: { weather_provider: 'open-meteo' } },
  { name: 'weather_provider invalid', body: { weather_provider: 'darksky' } },
  { name: 'weather_lat valid', body: { weather_lat: '52.5' } },
  { name: 'weather_lat null', body: { weather_lat: null }, seed: { weather_lat: '52.5' } },
  { name: 'weather_lat not a number', body: { weather_lat: 'north' } },
  { name: 'weather_lat out of range', body: { weather_lat: 91 } },
  { name: 'weather_lon valid', body: { weather_lon: 13.4 } },
  { name: 'weather_lon null', body: { weather_lon: null }, seed: { weather_lon: '13.4' } },
  { name: 'weather_lon out of range', body: { weather_lon: 181 } },
  { name: 'weather_city valid', body: { weather_city: '  Berlin  ' } },
  { name: 'weather_city number', body: { weather_city: 12345 } },
  { name: 'weather_city empty', body: { weather_city: '' }, seed: { weather_city: 'Berlin' } },
  { name: 'weather_city null', body: { weather_city: null }, seed: { weather_city: 'Berlin' } },
  { name: 'weather_units valid', body: { weather_units: 'imperial' } },
  { name: 'weather_units invalid', body: { weather_units: 'kelvin' } },
  { name: 'weather_auto_locate true', body: { weather_auto_locate: true } },
  { name: 'weather_auto_locate not boolean', body: { weather_auto_locate: 'x' } },

  // --- personal weather (an object with five fields) ------------------------
  { name: 'weather_user valid', body: { weather_user: { lat: '48.1', lon: 11.5, city: '  Muenchen  ', units: 'imperial', auto_locate: true } } },
  {
    name: 'weather_user all null',
    body: { weather_user: { lat: null, lon: null, city: null, units: null, auto_locate: null } },
    seed: {
      'weather_lat:user:self': '1', 'weather_lon:user:self': '2', 'weather_city:user:self': 'X',
      'weather_units:user:self': 'metric', 'weather_auto_locate:user:self': '1',
    },
  },
  { name: 'weather_user empty object', body: { weather_user: {} } },
  { name: 'weather_user empty city', body: { weather_user: { city: '' } }, seed: { 'weather_city:user:self': 'X' } },
  { name: 'weather_user not an object', body: { weather_user: 'x' } },
  { name: 'weather_user null', body: { weather_user: null } },
  { name: 'weather_user array', body: { weather_user: [] } },
  { name: 'weather_user lat not a number', body: { weather_user: { lat: 'x' } } },
  { name: 'weather_user lon out of range', body: { weather_user: { lon: 200 } } },
  { name: 'weather_user units invalid', body: { weather_user: { units: 'kelvin' } } },
  { name: 'weather_user auto_locate not boolean', body: { weather_user: { auto_locate: 'x' } } },

  // --- holidays (one gate for seven fields, dependent deletes) --------------
  { name: 'holiday_country new country without group', body: { holiday_country: 'AT' }, seed: { holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_group: 'DE-BY-X' } },
  { name: 'holiday_country same country', body: { holiday_country: 'DE' }, seed: { holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_group: 'DE-BY-X' } },
  { name: 'holiday_country new country with group', body: { holiday_country: 'BE', holiday_group: 'BE-FR' }, seed: { holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_group: 'DE-BY-X' } },
  { name: 'holiday_country null', body: { holiday_country: null }, seed: { holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_group: 'DE-BY-X' } },
  { name: 'holiday_country first time', body: { holiday_country: 'CH' } },
  { name: 'holiday_country invalid', body: { holiday_country: 'de' } },
  { name: 'holiday_subdivision valid', body: { holiday_subdivision: 'DE-BY' } },
  { name: 'holiday_subdivision null with stored subdivision', body: { holiday_subdivision: null }, seed: { holiday_country: 'CH', holiday_subdivision: 'CH-BE', holiday_group: 'CH-BE-VS' } },
  { name: 'holiday_subdivision null without stored subdivision', body: { holiday_subdivision: null }, seed: { holiday_country: 'BE', holiday_group: 'BE-FR' } },
  { name: 'holiday_subdivision null with new group', body: { holiday_subdivision: null, holiday_group: 'CH-BE-DE' }, seed: { holiday_country: 'CH', holiday_subdivision: 'CH-BE', holiday_group: 'CH-BE-VS' } },
  { name: 'holiday_subdivision invalid', body: { holiday_subdivision: 'DE' } },
  { name: 'holiday_group valid', body: { holiday_group: 'CH-BE-VS' } },
  { name: 'holiday_group empty', body: { holiday_group: '' }, seed: { holiday_group: 'CH-BE-VS' } },
  { name: 'holiday_group null', body: { holiday_group: null }, seed: { holiday_group: 'CH-BE-VS' } },
  { name: 'holiday_group invalid', body: { holiday_group: 'x' } },
  { name: 'holiday_show_public true', body: { holiday_show_public: true } },
  { name: 'holiday_show_public not boolean', body: { holiday_show_public: 'x' } },
  { name: 'holiday_show_school true', body: { holiday_show_school: true } },
  { name: 'holiday_show_school not boolean', body: { holiday_show_school: 'x' } },
  { name: 'holiday_public_color valid', body: { holiday_public_color: '#123456' } },
  { name: 'holiday_public_color invalid', body: { holiday_public_color: 'red' } },
  { name: 'holiday_school_color valid', body: { holiday_school_color: '#abcdef' } },
  { name: 'holiday_school_color invalid', body: { holiday_school_color: 'red' } },
  { name: 'holiday_country and subdivision null together', body: { holiday_country: 'AT', holiday_subdivision: null }, seed: { holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_group: 'DE-BY-X' } },

  // --- order: which refusal wins, and whole patch or nothing ----------------
  { name: 'order schedule_hidden_templates before visible_meal_types', body: { visible_meal_types: 'x', schedule_hidden_templates: 'x' } },
  { name: 'order timezone_hint_dismissed before visible_meal_types', body: { visible_meal_types: 'x', timezone_hint_dismissed: 'x' } },
  { name: 'order schedule_hidden_templates before timezone_hint_dismissed', body: { timezone_hint_dismissed: 'x', schedule_hidden_templates: 'x' } },
  { name: 'order early 403 before an invalid member field', body: { visible_meal_types: [], schedule_hidden_templates: ['work'] } },
  { name: 'order 400 before 403', body: { budget_mode: 'shared', currency: 'XYZ' } },
  { name: 'order 403 before 400', body: { hidden_modules: 'x', budget_mode: 'shared' } },
  { name: 'order two 400 in handler order', body: { date_format: 'iso', currency: 'XYZ' } },
  { name: 'order weather before weather_user', body: { weather_user: 'x', weather_provider: 'darksky' } },
  { name: 'order weather before holidays', body: { holiday_school_color: 'red', weather_units: 'kelvin' } },
  { name: 'order holiday fields in handler order', body: { holiday_school_color: 'red', holiday_country: 'de' } },
  { name: 'order personal 400 before admin 403', body: { tasks_default_points: 5, calendar_default_reminders: [7] } },
  { name: 'nothing written: member fields then a late 400', body: { currency: 'CHF', week_start: 'sunday', app_name: 'Neu', holiday_country: 'de' } },
  { name: 'nothing written: zone then a late 400', body: { timezone: 'America/New_York', holiday_group: 'x' } },
  { name: 'nothing written: disabled_modules then a late 400', body: { disabled_modules: ['health'], tasks_default_points: -1 } },
  { name: 'nothing written: member field then admin field', body: { currency: 'CHF', budget_mode: 'personal' } },
  { name: 'nothing written: personal fields then a late 400', body: { hidden_modules: ['budget'], weather_user: { lat: 'x' }, 'dashboard_today_glance': false } },
  { name: 'mixed: zone then hint false', body: { timezone: 'Europe/Berlin', timezone_hint_dismissed: false } },
  { name: 'mixed: all member fields at once', body: { visible_meal_types: ['lunch'], meal_type_names: { lunch: 'Z' }, currency: 'USD', date_format: 'mdy', time_format: '12h', week_start: 'saturday', app_name: 'X', housekeeping_payment_tasks: true, calendar_default_duration: 30 } },
];

for (const { name, body, seed = {} } of PUT_CASES) {
  for (const role of ['admin', 'member']) {
    test(`PUT ${name} as ${role}`, async () => {
      restore();
      applySeed(seed, role);
      const before = snapshot();
      const res = await http('PUT', '/api/v1/preferences', { headers: HEADERS[role], body });
      const rows = rowDiff(before, snapshot());
      const expected = EXPECTED.put?.[name]?.[role];
      assert.ok(expected, `an expectation for "${name}" as ${role}`);
      assert.equal(res.status, expected.status, `status: ${JSON.stringify(res.body)}`);
      if (expected.status === 200) {
        const whole = name === 'empty patch'
          ? EXPECTED.putBaseline[role]
          : { ...EXPECTED.putBaseline[role], ...expected.changed };
        assert.deepEqual(res.body, { data: whole }, 'the whole PUT body');
      } else {
        assert.deepEqual(res.body, expected.body, 'the whole refusal');
        // Whole patch or nothing (#1622): a refused patch leaves no row.
        assert.deepEqual(rows, {}, 'a refused patch writes nothing');
      }
      assert.deepEqual(rows, expected.rows, 'the sync_config rows written or deleted');
    });
  }
}

test('the empty-patch answer is the GET answer without weather_source and screensaver_enabled', async () => {
  for (const role of ['admin', 'member']) {
    restore();
    const got = await http('GET', '/api/v1/preferences', { headers: HEADERS[role] });
    const put = await http('PUT', '/api/v1/preferences', { headers: HEADERS[role], body: {} });
    const { weather_source: _ws, screensaver_enabled: _se, ...rest } = got.body.data;
    assert.deepEqual(put.body.data, rest, role);
  }
});

// --------------------------------------------------------------------------
// 4. Side effect: the household zone re-keys a series (F5 to #2034)
// --------------------------------------------------------------------------

/** @param {number} id */
function seriesState(id) {
  return {
    exceptions: db.prepare('SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ? ORDER BY exception_date').all(id)
      .map((/** @type {any} */ row) => row.exception_date),
    children: db.prepare('SELECT title, recurrence_id FROM calendar_events WHERE recurrence_parent_id = ? ORDER BY recurrence_id').all(id),
  };
}

/**
 * The key the calendar shows for the occurrence on local day `day` in `zone`.
 * @param {number} seriesId @param {string} zone @param {string} day
 */
function keyShownOn(seriesId, zone, day) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  const shift = (/** @type {string} */ d, /** @type {number} */ n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return ymd.format(t); };
  const dayIn = (/** @type {string} */ iso) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const hits = expandAndResolveEventRows(db, db.prepare('SELECT * FROM calendar_events').all(), shift(day, -2), shift(day, 2))
    .filter((/** @type {any} */ event) => Number(event.series_id ?? event.id) === seriesId && !event.is_occurrence_override && dayIn(event.start_datetime) === day);
  assert.equal(hits.length, 1, `one occurrence on ${day} in ${zone}`);
  return hits[0].recurrence_identity ?? hits[0].recurrence_id;
}

/** @param {string} fromZone @param {Record<string, unknown>} body */
async function zoneCase(fromZone, body) {
  restore();
  db.prepare('DELETE FROM calendar_events').run();
  applySeed({ household_timezone: fromZone }, 'admin');
  // A series whose digits are the household's wall clock (#1993): its start
  // has no zone of its own, its tzid differs from the household.
  const id = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, tzid, recurrence_rule, created_by, color, icon, visibility)
    VALUES ('Serie', '2035-03-20T21:30', '2035-03-20T22:30', 0, 'America/New_York', 'FREQ=DAILY', ?, '#007AFF', 'calendar', 'all')
  `).run(adminId).lastInsertRowid);
  deleteOccurrence(db, { seriesId: id, recurrenceId: keyShownOn(id, 'America/New_York', '2035-03-25'), actorId: adminId });
  upsertOccurrenceOverride(db, /** @type {any} */ ({
    seriesId: id, recurrenceId: keyShownOn(id, 'America/New_York', '2035-03-26'), actorId: adminId, changes: { title: 'Eigener Titel' },
  }));
  const before = seriesState(id);
  const configBefore = snapshot();
  const res = await http('PUT', '/api/v1/preferences', { headers: HEADERS.admin, body });
  const result = { status: res.status, before, after: seriesState(id), rows: rowDiff(configBefore, snapshot()) };
  db.prepare('DELETE FROM calendar_events').run();
  return result;
}

test('timezone: a zone change re-keys the exceptions and linked occurrences of a series and sets the hint flag', async () => {
  const actual = await zoneCase('Europe/Berlin', { timezone: 'America/New_York' });
  assert.equal(actual.status, 200);
  assert.notDeepEqual(actual.after, actual.before, 'the keys moved');
  assert.deepEqual(actual, EXPECTED.zone?.change);
});

test('timezone: writing the zone the household already has re-keys nothing and still sets the hint flag', async () => {
  const actual = await zoneCase('Europe/Berlin', { timezone: 'Europe/Berlin' });
  assert.equal(actual.status, 200);
  assert.deepEqual(actual.after, actual.before, 'nothing moved');
  assert.deepEqual(actual, EXPECTED.zone?.same);
});

test('timezone: a patch refused AFTER the zone was written rolls the re-keying back', async () => {
  // The zone block re-keys in its own (nested) transaction; the holiday group
  // is refused further down, and the outer transaction takes both back.
  const actual = await zoneCase('Europe/Berlin', { timezone: 'America/New_York', holiday_group: 'x' });
  assert.equal(actual.status, 400);
  assert.deepEqual(actual.after, actual.before, 'nothing moved');
  assert.deepEqual(actual.rows, {});
  assert.deepEqual(actual, EXPECTED.zone?.refused);
});

// --------------------------------------------------------------------------
// 5. Side effects of `disabled_modules` and `health_prevention_notify_caregivers`
//    (phase 2, C3 stage 2): the cases above hold only their sync_config rows.
//    These hold what the two syncs do, so a refactor that stops calling them
//    is red. Expectations as data next to the cases, not in the JSON file.
// --------------------------------------------------------------------------

// A fast far in the future: its goal reminder (start + 16 h) is never in the
// past, whatever the clock says.
const FAST_START = '2099-01-01T00:00:00.000Z';
const FAST_GOAL_REMINDER = '2099-01-01T16:00:00.000Z';

/** The admin's pending fasting reminders, as data. */
function fastingReminders() {
  return db.prepare(`SELECT entity_type, remind_at FROM reminders
    WHERE created_by = ? AND entity_type IN ('fasting_goal', 'fasting_next_start') ORDER BY id`).all(adminId)
    .map((/** @type {any} */ row) => ({ ...row }));
}

/**
 * The admin fasts with a goal reminder switched on; `reminder` seeds a pending
 * goal reminder row (or none), `disabled` the stored module list.
 * @param {{ disabled: string, reminder: string | null }} seed @param {unknown} disabledModules
 */
async function fastingCase({ disabled, reminder }, disabledModules) {
  restore();
  db.prepare("DELETE FROM reminders WHERE entity_type IN ('fasting_goal', 'fasting_next_start')").run();
  db.prepare('DELETE FROM health_fasts').run();
  db.prepare('DELETE FROM health_fasting_settings').run();
  applySeed({ disabled_modules: disabled }, 'admin');
  db.prepare(`INSERT INTO health_fasting_settings (user_id, default_goal_minutes, remind_goal, remind_next_start)
    VALUES (?, 960, 1, 0)`).run(adminId);
  const fastId = Number(db.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes, created_by)
    VALUES (?, ?, NULL, 'UTC', 960, ?)`).run(adminId, FAST_START, adminId).lastInsertRowid);
  if (reminder) {
    db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('fasting_goal', ?, ?, ?)")
      .run(fastId, reminder, adminId);
  }
  const before = fastingReminders();
  const res = await http('PUT', '/api/v1/preferences', { headers: HEADERS.admin, body: { disabled_modules: disabledModules } });
  const result = { status: res.status, before, after: fastingReminders() };
  db.prepare("DELETE FROM reminders WHERE entity_type IN ('fasting_goal', 'fasting_next_start')").run();
  db.prepare('DELETE FROM health_fasts').run();
  db.prepare('DELETE FROM health_fasting_settings').run();
  return result;
}

const FASTING_EXPECTED = {
  // health switched off: the sync removes the pending reminder (#1279 path).
  off: {
    status: 200,
    before: [{ entity_type: 'fasting_goal', remind_at: FAST_GOAL_REMINDER }],
    after: [],
  },
  // health switched back on: the sync creates the reminder that is due.
  on: {
    status: 200,
    before: [],
    after: [{ entity_type: 'fasting_goal', remind_at: FAST_GOAL_REMINDER }],
  },
  // health unchanged: no sync, a stale row stays as it is.
  unchanged: {
    status: 200,
    before: [{ entity_type: 'fasting_goal', remind_at: '2099-02-02T00:00:00.000Z' }],
    after: [{ entity_type: 'fasting_goal', remind_at: '2099-02-02T00:00:00.000Z' }],
  },
};

test('disabled_modules: switching health off re-syncs the fasting reminders (the pending one goes)', async () => {
  const actual = await fastingCase({ disabled: '[]', reminder: FAST_GOAL_REMINDER }, ['health']);
  assert.deepEqual(actual, FASTING_EXPECTED.off);
});

test('disabled_modules: switching health back on re-syncs the fasting reminders (the due one comes)', async () => {
  const actual = await fastingCase({ disabled: '["health"]', reminder: null }, []);
  assert.deepEqual(actual, FASTING_EXPECTED.on);
});

test('disabled_modules: a list without a change for health does not re-sync the fasting reminders', async () => {
  const actual = await fastingCase({ disabled: '[]', reminder: '2099-02-02T00:00:00.000Z' }, ['tasks']);
  assert.deepEqual(actual, FASTING_EXPECTED.unchanged);
});

/** The prevention reminders of the household, as data. */
function preventionReminders() {
  return db.prepare(`SELECT created_by, assigned_from, remind_at FROM reminders
    WHERE entity_type = 'health_prevention_due' ORDER BY id`).all()
    .map((/** @type {any} */ row) => ({ ...row, created_by: ID_LABELS[String(row.created_by)] ?? row.created_by }));
}

/**
 * The admin has one prevention record due in 2099 and no reminder for it.
 * `failing` makes every insert of a prevention reminder abort (a temporary
 * trigger on this connection), so the sync throws.
 * @param {unknown} value @param {{ failing?: boolean }} [options]
 */
async function preventionCase(value, { failing = false } = {}) {
  restore();
  db.prepare("DELETE FROM reminders WHERE entity_type = 'health_prevention_due'").run();
  db.prepare('DELETE FROM health_prevention_records').run();
  db.prepare('DELETE FROM health_prevention_types').run();
  const typeId = Number(db.prepare(`INSERT INTO health_prevention_types (name, kind, default_interval_months)
    VALUES ('Tetanus', 'vaccination', 120)`).run().lastInsertRowid);
  db.prepare(`INSERT INTO health_prevention_records (user_id, type_id, given_on, next_due_on, visibility, created_by)
    VALUES (?, ?, '2089-06-01', '2099-06-01', 'private', ?)`).run(adminId, typeId, adminId);
  if (failing) {
    db.exec(`CREATE TEMP TRIGGER settings_registry_probe BEFORE INSERT ON reminders
      WHEN NEW.entity_type = 'health_prevention_due' BEGIN SELECT RAISE(ABORT, 'probe: prevention sync fails'); END`);
  }
  const before = { reminders: preventionReminders(), rows: snapshot() };
  let res;
  try {
    res = await http('PUT', '/api/v1/preferences', { headers: HEADERS.admin, body: { health_prevention_notify_caregivers: value } });
  } finally {
    if (failing) db.exec('DROP TRIGGER IF EXISTS temp.settings_registry_probe');
  }
  const result = {
    status: res.status,
    before: before.reminders,
    after: preventionReminders(),
    rows: rowDiff(before.rows, snapshot()),
  };
  db.prepare("DELETE FROM reminders WHERE entity_type = 'health_prevention_due'").run();
  db.prepare('DELETE FROM health_prevention_records').run();
  db.prepare('DELETE FROM health_prevention_types').run();
  return result;
}

const PREVENTION_EXPECTED = {
  // The flag is written and the sync runs at once for the person: the record
  // due in 2099 gets its own reminder (30 days before, 09:00 household time).
  on: {
    status: 200,
    before: [],
    after: [{ created_by: 'admin', assigned_from: null, remind_at: '2099-05-02T09:00' }],
    rows: { 'health_prevention_notify_caregivers:user:admin': '1' },
  },
  // A failing sync is only logged: the answer is 200 and the flag stands.
  failing: {
    status: 200,
    before: [],
    after: [],
    rows: { 'health_prevention_notify_caregivers:user:admin': '1' },
  },
};

test('health_prevention_notify_caregivers: writing the flag syncs the prevention reminders of the person', async () => {
  const actual = await preventionCase(true);
  assert.deepEqual(actual, PREVENTION_EXPECTED.on);
});

test('health_prevention_notify_caregivers: a failing sync is only logged, the patch stands', async () => {
  const actual = await preventionCase(true, { failing: true });
  assert.deepEqual(actual, PREVENTION_EXPECTED.failing);
});

// --------------------------------------------------------------------------
// 6. The registry (phase 2, C3 stage 2): its catalog against what the route
//    was MEASURED to do above - the fields of GET and PUT, the member's 403,
//    and the rows a valid write left. Data against data, no source text.
// --------------------------------------------------------------------------

/** GET fields the route builds itself (they need a service or the request). */
const ROUTE_VIEWS = ['weather_source', 'screensaver_enabled', 'display_device_settings'];

/** Every field of a GET answer, over every recorded state and role. */
const GET_FIELDS = [...new Set(Object.values(EXPECTED.get).flatMap((byRole) => Object.values(byRole)
  .flatMap((/** @type {any} */ answer) => Object.keys(answer.body.data))))].sort();

/** Every field a PUT case sends, but for the case that sends unknown fields. */
const PUT_FIELDS = [...new Set(PUT_CASES.filter((c) => c.name !== 'unknown field only' && !Array.isArray(c.body))
  .flatMap((c) => Object.keys(/** @type {object} */ (c.body))))].sort();

/** The cases that send exactly one field, by field. */
const SINGLE_FIELD_CASES = Object.groupBy(
  PUT_CASES.filter((c) => !Array.isArray(c.body) && Object.keys(/** @type {object} */ (c.body)).length === 1
    && PUT_FIELDS.includes(Object.keys(/** @type {object} */ (c.body))[0])),
  (c) => Object.keys(/** @type {object} */ (c.body))[0],
);

const catalogByField = () => new Map(settingsCatalog().map((entry) => [entry.field, entry]));

test('registry: the measured fields are what this suite expects (52 PUT fields, the route views)', () => {
  assert.equal(PUT_FIELDS.length, 52, PUT_FIELDS.join(', '));
  for (const field of PUT_FIELDS) assert.ok(SINGLE_FIELD_CASES[field]?.length, `a single-field case for ${field}`);
  for (const view of ROUTE_VIEWS) assert.ok(GET_FIELDS.includes(view), view);
});

test('registry: every GET field (but the route views) and every PUT field stands in settingsCatalog()', () => {
  const catalog = catalogByField();
  const wanted = [...new Set([...GET_FIELDS.filter((f) => !ROUTE_VIEWS.includes(f)), ...PUT_FIELDS])].sort();
  assert.deepEqual(wanted.filter((field) => !catalog.has(field)), [], 'fields missing in the catalog');
  assert.deepEqual([...catalog.keys()].filter((field) => !wanted.includes(field)).sort(), [], 'catalog fields neither GET nor PUT answers');
  assert.equal(catalog.size, settingsCatalog().length, 'one entry per field');
});

test('registry: `write` of every field is the measured right (member 403 = admin, else member; not written = none)', () => {
  const catalog = catalogByField();
  const mismatches = [];
  const fields = [...new Set([...GET_FIELDS.filter((f) => !ROUTE_VIEWS.includes(f)), ...PUT_FIELDS])].sort();
  for (const field of fields) {
    let measured = 'none';
    if (PUT_FIELDS.includes(field)) {
      const statuses = new Set((SINGLE_FIELD_CASES[field] ?? []).map((c) => EXPECTED.put[c.name].member.status === 403));
      assert.equal(statuses.size, 1, `${field}: the member's cases agree on 403 or not`);
      measured = statuses.has(true) ? 'admin' : 'member';
    }
    if (catalog.get(field)?.write !== measured) mismatches.push(`${field}: catalog ${catalog.get(field)?.write}, route ${measured}`);
  }
  assert.deepEqual(mismatches, []);
});

test('registry: `scope` and `storage` of every written field match the rows a valid write left', () => {
  const catalog = catalogByField();
  const mismatches = [];
  for (const field of PUT_FIELDS) {
    const entry = catalog.get(field);
    const written = new Set((SINGLE_FIELD_CASES[field] ?? [])
      .filter((c) => EXPECTED.put[c.name].admin.status === 200)
      .flatMap((c) => Object.keys(EXPECTED.put[c.name].admin.rows))
      .map((key) => key.replace(/:user:admin$/, ':user:<id>')));
    assert.ok(written.size, `${field}: a valid case writes a row`);
    const personal = [...written].every((key) => key.endsWith(':user:<id>'));
    const household = [...written].every((key) => !key.includes(':user:'));
    const measured = personal ? 'personal' : household ? 'household' : 'mixed';
    const declared = entry?.scope === 'household-default' ? 'household' : entry?.scope;
    if (declared !== measured) mismatches.push(`${field}: scope ${entry?.scope}, rows ${[...written].join(', ')}`);
    const unlisted = [...written].filter((key) => !entry?.storage.includes(key));
    if (unlisted.length) mismatches.push(`${field}: storage lacks ${unlisted.join(', ')}`);
  }
  assert.deepEqual(mismatches, []);
});

test('registry: the answers keep the field ORDER recorded from the route before C3 (deepEqual does not see it)', async () => {
  for (const role of ['admin', 'member', 'display']) {
    restore();
    const got = await http('GET', '/api/v1/preferences', { headers: HEADERS[role] });
    assert.equal(got.status, 200, `GET ${role}: ${JSON.stringify(got.body)}`);
    assert.deepEqual(Object.keys(got.body.data), Object.keys(EXPECTED.get.fresh[role].body.data), `GET ${role}`);
  }
  for (const role of ['admin', 'member']) {
    restore();
    const put = await http('PUT', '/api/v1/preferences', { headers: HEADERS[role], body: {} });
    assert.deepEqual(Object.keys(put.body.data), Object.keys(EXPECTED.putBaseline[role]), `PUT ${role}`);
  }
});

/**
 * Imports `file` in a fresh process whose DB_PATH points into an empty
 * directory and returns what is in it afterwards: server/db.js opens (and
 * creates) its database on import, so any file there means db.js was loaded.
 * @param {string} file from the repository root
 */
function filesAfterImport(file) {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-settings-leaf-'));
  try {
    const url = pathToFileURL(fileURLToPath(new URL(`../${file}`, import.meta.url))).href;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
      env: { ...process.env, DB_PATH: join(dir, 'never.db'), LOG_LEVEL: 'error', DB_ENCRYPTION_AUTO_KEY: 'false' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `import of ${file} failed:\n${run.stderr}`);
    return readdirSync(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registry: the probe sees a database - importing server/db.js creates one', () => {
  assert.ok(filesAfterImport('server/db.js').includes('never.db'));
});

test('registry: importing server/settings/registry.ts opens no database (a leaf, the connection is a parameter)', () => {
  assert.deepEqual(filesAfterImport('server/settings/registry.ts'), []);
});

test('registry: the route reads and writes no setting itself - every sync_config statement of GET and PUT comes from elsewhere', async () => {
  // The calls are watched on the connection itself: each statement that names
  // sync_config is attributed to the frame that prepared it. A statement prepared
  // in server/routes/preferences.js is the route reaching past the registry.
  const ROUTE = fileURLToPath(new URL('../server/routes/preferences.js', import.meta.url));
  const original = db.prepare;
  /** @type {string[]} */
  const callers = [];
  db.prepare = function prepare(/** @type {string} */ sql) {
    if (/sync_config/.test(sql)) {
      const frame = (new Error().stack ?? '').split('\n')[2] ?? '';
      callers.push(frame.replace(/^\s*at\s+/, ''));
    }
    return original.call(this, sql);
  };
  try {
    restore();
    applySeed(GET_STATES.valid.seed, 'admin');
    for (const role of ['admin', 'member', 'display']) {
      assert.equal((await http('GET', '/api/v1/preferences', { headers: HEADERS[role] })).status, 200);
    }
    const everyField = { .../** @type {object} */ (PUT_CASES.find((c) => c.name === 'mixed: all member fields at once')?.body),
      timezone: 'Europe/Berlin', timezone_hint_dismissed: true, holiday_country: 'DE', weather_user: { city: 'X' },
      disabled_modules: ['budget'], health_prevention_notify_caregivers: false, schedule_hidden_templates: ['work'] };
    assert.equal((await http('PUT', '/api/v1/preferences', { headers: HEADERS.admin, body: everyField })).status, 200);
  } finally {
    db.prepare = original;
  }
  assert.ok(callers.length >= 50, `only ${callers.length} sync_config statements seen - the probe does not reach the route`);
  assert.deepEqual(callers.filter((frame) => frame.includes(ROUTE)), []);
});

test('registry: readSettings and readSetting answer what GET answered on the recorded states (but the route views)', () => {
  for (const state of ['fresh', 'fallback']) {
    for (const role of ['admin', 'member']) {
      restore();
      applySeed(GET_STATES[state].seed, role);
      const { weather_source: _ws, screensaver_enabled: _se, ...recorded } = EXPECTED.get[state][role].body.data;
      assert.deepEqual(readSettings(db, USER_IDS[role]), recorded, `${state} ${role}`);
      for (const [field, value] of Object.entries(recorded)) {
        assert.deepEqual(readSetting(db, field, USER_IDS[role]), value, `${state} ${role} ${field}`);
      }
    }
  }
});

test('registry: `weather_user` without an account is `unauthenticated` (the 401 the server cannot reach)', () => {
  /** @type {any} */
  const actor = Object.freeze({
    kind: 'session', userId: null, role: 'member', familyRole: null, scopes: null, moduleAccess: null, deviceId: null, unresolved: true,
  });
  const effects = { householdZoneChanged() {}, healthModuleToggled() {}, preventionCaregiversChanged() {} };
  restore();
  const before = snapshot();
  assert.deepEqual(writeSettings(db, actor, { weather_user: { city: 'X' } }, effects), { kind: 'unauthenticated' });
  // The object check comes first, as in the route.
  assert.deepEqual(writeSettings(db, actor, { weather_user: 'x' }, effects), { kind: 'invalid', message: 'weather_user must be an object.' });
  assert.deepEqual(rowDiff(before, snapshot()), {}, 'nothing written');
});

// --------------------------------------------------------------------------
// Completeness of the data: every expectation belongs to a case
// --------------------------------------------------------------------------

test('every recorded expectation belongs to a case of this suite (no stale rows)', () => {
  const names = new Set(PUT_CASES.map((c) => c.name));
  assert.equal(names.size, PUT_CASES.length, 'case names are unique');
  assert.deepEqual(Object.keys(EXPECTED.put).filter((name) => !names.has(name)), []);
  assert.deepEqual(Object.keys(EXPECTED.get).sort(), Object.keys(GET_STATES).sort());
});
