/**
 * Module: the gate table of test/test-admin-gates.js (phase 2, sections C1 and C2)
 * Purpose: every admin gate of the server, one row each, with the answer a
 *          MEMBER gets. C1 recorded the answers as they were (three texts,
 *          mostly without a reason) and moved the admin question into
 *          server/authorize/; C2 gave every pure admin gate ONE refusal,
 *          ADMIN_REQUIRED, sent by refuseAdmin() in
 *          server/middleware/require-admin.js. Two rows keep their own answer
 *          (FEED_ADMIN_ONLY, REOPEN_NOT_ALLOWED).
 *
 * A row names its SOURCE SITE as `form` + `file` + `key`. The suite counts the
 * sites in the source (see gateSites() in the suite) and compares the multiset
 * with the rows here plus EXCEPTIONS and MIXED: a new gate without a row turns
 * the suite red.
 *
 *   form 'requireAdmin'  a use of the middleware as a route argument or in
 *                        `router.use(...)` (server/middleware/require-admin.js;
 *                        until C2 four routers had a local copy of their own);
 *   form 'assertAdmin'   a call of assertAdmin() in routes/housekeeping.js; the
 *                        call inside assertMayTouchSettled() counts once per
 *                        route that calls that helper;
 *   form 'inline'        a call of refuseAdmin(), or a 403 of its own right
 *                        behind a negated admin question (`!isAdminRequest(req)`,
 *                        `!isAdmin`) within three lines.
 *
 * `key` is `<METHOD> <router-local path>` of the enclosing route (`USE ` for
 * `router.use(requireAdmin)`), so it survives line shifts. `path` is the full
 * URL; a function takes the seed (test-admin-gates.js, `seed`).
 *
 * Every row sends invalid or harmless input where the route would act: under a
 * mutant that opens the gate (test-admin-gates.js, header) a member reaches the
 * handler, and the run must stay one that ends.
 */

/**
 * The one refusal of an admin gate (phase 2, C2): every gate below answers a
 * member with it, sent by refuseAdmin() in server/middleware/require-admin.js.
 */
export const ADMIN_REQUIRED = Object.freeze({ error: 'Admin access required.', code: 403, reason: 'admin_required' });
export const DEVICE_CREDENTIAL = Object.freeze({
  error: 'This is not available on a signed-in device.', code: 403, reason: 'device_credential',
});
// Two refusals behind an admin question that carry their own information and
// stay as they are: a page reads `calendar_feed_admin_only`, and
// `rewards_reopen_not_allowed` also refuses an admin (auto-fulfilment).
const FEED_ADMIN_ONLY = Object.freeze({ error: 'Admin access required.', code: 403, reason: 'calendar_feed_admin_only' });
const REOPEN_NOT_ALLOWED = Object.freeze({
  error: 'This decision cannot be taken back here.', code: 403, reason: 'rewards_reopen_not_allowed',
});

const NO_ID = 999999;

/**
 * A `router.use(requireAdmin)`: the gate stands in front of every route of the router.
 * @param {GateRow} row
 * @returns {GateRow}
 */
const useRow = (row) => ({ ...row, method: 'GET', key: 'USE ' });

/**
 * @typedef {{ ids: Record<string, number> }} GateSeed
 * @typedef {{
 *   form: string,
 *   file: string,
 *   key: string,
 *   method: string,
 *   path: string | ((seed: GateSeed) => string),
 *   body?: unknown,
 *   expect: Readonly<Record<string, unknown>>,
 *   field?: string,
 * }} GateRow
 * @typedef {[string, string, (string | ((seed: GateSeed) => string))?, unknown?]} RouteSpec
 */

/**
 * @param {string} file @param {string} prefix @param {Readonly<Record<string, unknown>>} expect
 * @param {RouteSpec[]} routes
 * @returns {GateRow[]}
 */
function middlewareRows(file, prefix, expect, routes) {
  return routes.map(([method, local, concrete, body]) => ({
    form: 'requireAdmin', file, key: `${method} ${local}`, method,
    path: typeof concrete === 'function' ? concrete : `${prefix}${concrete ?? local}`,
    ...(body !== undefined ? { body } : {}),
    expect,
  }));
}

/** @type {GateRow[]} */
export const ROWS = [
  // --- auth router (/api/v1/auth, mounted before the /api/v1 gates) ---------
  ...middlewareRows('server/auth.js', '/api/v1/auth', ADMIN_REQUIRED, [
    ['POST', '/invites', '/invites', {}],
    ['GET', '/invites'],
    ['DELETE', '/invites/:id', `/invites/${NO_ID}`],
    ['GET', '/2fa/overview'],
    ['PUT', '/2fa/require', '/2fa/require', {}],
    ['POST', '/users/:id/devices/sign-out', `/users/${NO_ID}/devices/sign-out`, {}],
    ['GET', '/api-tokens'],
    ['POST', '/api-tokens', '/api-tokens', {}],
    ['DELETE', '/api-tokens/:id', `/api-tokens/${NO_ID}`],
    ['POST', '/api-tokens/:id/remove', `/api-tokens/${NO_ID}/remove`, {}],
    ['POST', '/users', '/users', {}],
    ['PATCH', '/users/:id', `/users/${NO_ID}`, {}],
    ['DELETE', '/users/:id', `/users/${NO_ID}`],
  ]),
  // --- server/index.js -------------------------------------------------------
  ...middlewareRows('server/index.js', '', ADMIN_REQUIRED, [
    ['GET', '/docs'],
    ['GET', '/api/v1/openapi.json'],
    ['GET', '/openapi.json'],
  ]),
  // --- backup ----------------------------------------------------------------
  ...middlewareRows('server/routes/backup.js', '/api/v1/backup', ADMIN_REQUIRED, [
    ['GET', '/status'],
    ['GET', '/database-key'],
    ['GET', '/database'],
    ['POST', '/restore', '/restore', {}],
    ['POST', '/trigger', '/trigger', {}],
    ['GET', '/webdav/config'],
    ['PUT', '/webdav/config', '/webdav/config', { url: 1 }],
    ['POST', '/webdav/test', '/webdav/test', { url: 1 }],
    ['GET', '/webdav/files'],
    ['POST', '/webdav/trigger', '/webdav/trigger', {}],
  ]),
  // --- calendar sub-routers (mounted without a prefix under /api/v1/calendar)
  ...middlewareRows('server/routes/calendar/apple.js', '/api/v1/calendar', ADMIN_REQUIRED, [
    ['POST', '/apple/sync', '/apple/sync', {}],
    ['POST', '/apple/connect', '/apple/connect', {}],
    ['DELETE', '/apple/disconnect'],
    ['DELETE', '/apple/mirrored-events'],
  ]),
  ...middlewareRows('server/routes/calendar/caldav.js', '/api/v1/calendar', ADMIN_REQUIRED, [
    ['POST', '/caldav/accounts', '/caldav/accounts', {}],
    ['GET', '/caldav/accounts'],
    ['PUT', '/caldav/accounts/:id', `/caldav/accounts/${NO_ID}`, {}],
    ['DELETE', '/caldav/accounts/:id', `/caldav/accounts/${NO_ID}`],
    ['GET', '/caldav/accounts/:id/calendars', `/caldav/accounts/${NO_ID}/calendars`],
    ['PATCH', '/caldav/accounts/:id/calendars', `/caldav/accounts/${NO_ID}/calendars`, {}],
    ['POST', '/caldav/sync', '/caldav/sync', {}],
    ['GET', '/caldav/accounts/:id/reminder-lists', `/caldav/accounts/${NO_ID}/reminder-lists`],
    ['PATCH', '/caldav/accounts/:id/reminder-lists', `/caldav/accounts/${NO_ID}/reminder-lists`, {}],
    ['POST', '/caldav/reminders/sync', '/caldav/reminders/sync', {}],
  ]),
  ...middlewareRows('server/routes/calendar/google.js', '/api/v1/calendar', ADMIN_REQUIRED, [
    ['GET', '/google/auth'],
    ['POST', '/google/sync', '/google/sync', {}],
    ['GET', '/google/calendars'],
    ['PATCH', '/google/calendars', '/google/calendars', {}],
    ['PATCH', '/external-calendars', '/external-calendars', {}],
    ['GET', '/external-calendars/default-assignee-backfill'],
    ['POST', '/external-calendars/default-assignee-backfill', '/external-calendars/default-assignee-backfill', {}],
    ['DELETE', '/google/disconnect'],
    ['DELETE', '/google/mirrored-events'],
    ['PUT', '/google/readonly', '/google/readonly', {}],
  ]),
  ...middlewareRows('server/routes/calendar/local-calendars.js', '/api/v1/calendar', ADMIN_REQUIRED, [
    ['POST', '/calendars/:id/feed/regenerate', `/calendars/${NO_ID}/feed/regenerate`, {}],
    ['DELETE', '/calendars/:id/feed', `/calendars/${NO_ID}/feed`],
  ]),
  ...middlewareRows('server/routes/calendar/outlook.js', '/api/v1/calendar', ADMIN_REQUIRED, [
    ['GET', '/outlook/auth'],
    ['GET', '/outlook/accounts'],
    ['PUT', '/outlook/accounts/:id', `/outlook/accounts/${NO_ID}`, {}],
    ['DELETE', '/outlook/accounts/:id', `/outlook/accounts/${NO_ID}`],
    ['GET', '/outlook/accounts/:id/calendars', `/outlook/accounts/${NO_ID}/calendars`],
    ['PATCH', '/outlook/accounts/:id/calendars', `/outlook/accounts/${NO_ID}/calendars`, {}],
    ['POST', '/outlook/sync', '/outlook/sync', {}],
  ]),
  // --- routers behind router.use(requireAdmin) ------------------------------
  ...middlewareRows('server/routes/cardav.js', '/api/v1/contacts/cardav', ADMIN_REQUIRED, [
    ['USE', '', '/accounts'],
  ]).map(useRow),
  ...middlewareRows('server/routes/displays.js', '/api/v1/displays', ADMIN_REQUIRED, [
    ['USE', '', ''],
  ]).map(useRow),
  ...middlewareRows('server/routes/permissions.js', '/api/v1/permissions', ADMIN_REQUIRED, [
    ['USE', '', ''],
  ]).map(useRow),
  // --- document storage -------------------------------------------------------
  ...middlewareRows('server/routes/document-storage-google-drive.js', '/api/v1/documents/storage/google-drive', ADMIN_REQUIRED, [
    ['GET', '/auth'],
    ['GET', '/callback'],
    ['POST', '/test', '/test', {}],
    ['DELETE', '/disconnect'],
  ]),
  // --- health ----------------------------------------------------------------
  ...middlewareRows('server/routes/health/caregivers.js', '/api/v1/health', ADMIN_REQUIRED, [
    ['GET', '/caregivers'],
    ['PUT', '/caregivers/:subjectId', `/caregivers/${NO_ID}`, {}],
  ]),
  ...middlewareRows('server/routes/health/prevention.js', '/api/v1/health', ADMIN_REQUIRED, [
    ['POST', '/prevention/types', '/prevention/types', {}],
    ['PATCH', '/prevention/types/:id', `/prevention/types/${NO_ID}`, {}],
    ['DELETE', '/prevention/types/:id', `/prevention/types/${NO_ID}`],
  ]),
  // --- modules, system --------------------------------------------------------
  ...middlewareRows('server/routes/modules.js', '/api/v1/modules', ADMIN_REQUIRED, [
    ['GET', '/install/info'],
    ['POST', '/install/zip', '/install/zip', {}],
    ['POST', '/install/github', '/install/github', {}],
    ['PATCH', '/:id', '/no-such-module', {}],
    ['DELETE', '/:id', '/no-such-module'],
  ]),
  ...middlewareRows('server/routes/system.js', '/api/v1/system', ADMIN_REQUIRED, [
    ['GET', '/diagnostics'],
  ]),
  // --- the routers that had a local copy until C2 -------------------------------
  ...middlewareRows('server/routes/email.js', '/api/v1/email', ADMIN_REQUIRED, [
    ['GET', '/config'],
    ['PUT', '/config', '/config', { smtp_port: 'x' }],
    ['POST', '/test', '/test', {}],
  ]),
  ...middlewareRows('server/routes/notifications.js', '/api/v1/notifications', ADMIN_REQUIRED, [
    ['USE', '', '/providers'],
  ]).map(useRow),
  ...middlewareRows('server/routes/rewards.js', '/api/v1/rewards', ADMIN_REQUIRED, [
    ['GET', '/participants'],
    ['PUT', '/participants/:userId', `/participants/${NO_ID}`, {}],
    ['POST', '/catalog', '/catalog', {}],
    ['PATCH', '/catalog/:id', `/catalog/${NO_ID}`, {}],
    ['DELETE', '/catalog/:id', `/catalog/${NO_ID}`],
    ['POST', '/bonus', '/bonus', {}],
    ['POST', '/money/entries', '/money/entries', {}],
    ['POST', '/money/accounts', '/money/accounts', {}],
    ['DELETE', '/money/accounts/:userId', `/money/accounts/${NO_ID}`],
    ['PUT', '/money/plans/:userId', `/money/plans/${NO_ID}`, {}],
    ['DELETE', '/money/plans/:userId', `/money/plans/${NO_ID}`],
  ]),
  ...middlewareRows('server/routes/screensaver.js', '/api/v1/screensaver', ADMIN_REQUIRED, [
    ['GET', '/config'],
    ['PUT', '/config', '/config', { interval: 'x' }],
    ['POST', '/test', '/test', {}],
  ]),

  // --- assertAdmin (housekeeping) ----------------------------------------------
  // A settled (paid) visit: assertMayTouchSettled() asks assertAdmin().
  { form: 'assertAdmin', file: 'server/routes/housekeeping.js', key: 'POST /worker', method: 'POST',
    path: '/api/v1/housekeeping/worker', body: {}, expect: ADMIN_REQUIRED },
  { form: 'assertAdmin', file: 'server/routes/housekeeping.js', key: 'POST /visits/:id/unpay', method: 'POST',
    path: (s) => `/api/v1/housekeeping/visits/${s.ids.paidVisit}/unpay`, body: {}, expect: ADMIN_REQUIRED },
  { form: 'assertAdmin', file: 'server/routes/housekeeping.js', key: 'PUT /visits/:id', method: 'PUT',
    path: (s) => `/api/v1/housekeeping/visits/${s.ids.paidVisit}`, body: { daily_rate: 'x' }, expect: ADMIN_REQUIRED },
  { form: 'assertAdmin', file: 'server/routes/housekeeping.js', key: 'POST /visits/:id/pay', method: 'POST',
    path: (s) => `/api/v1/housekeeping/visits/${s.ids.paidVisit}/pay`, body: {}, expect: ADMIN_REQUIRED },
  { form: 'assertAdmin', file: 'server/routes/housekeeping.js', key: 'DELETE /visits/:id', method: 'DELETE',
    path: (s) => `/api/v1/housekeeping/visits/${s.ids.paidVisit}`, expect: ADMIN_REQUIRED },

  // --- inline gates --------------------------------------------------------------
  // PUT /preferences: one row per gated field group (weather and holidays have
  // one gate for several fields each). Values are invalid where the route
  // validates, so an opened gate ends in a 400 rather than a household change.
  .../** @type {[string, unknown][]} */ ([
    ['schedule_hidden_templates', 'x'],
    ['timezone_hint_dismissed', 'x'],
    ['budget_mode', 'x'],
    ['region', 1],
    ['timezone', 'No/Such_Zone'],
    ['language', 1],
    ['dashboard_widgets_default', 'x'],
    ['dashboard_today_glance_default', 'x'],
    ['disabled_modules', 'x'],
    ['health_cycle_enabled', 'x'],
    ['rewards_require_approval', 'x'],
    ['tasks_subtasks_expanded', 'x'],
    ['tasks_default_points', 'x'],
    ['tasks_late_decay_enabled', 'x'],
    ['countdown_grace_days', 'x'],
    ['weather_units', 'x'],
    ['holiday_public_color', 'x'],
  ]).map(([field, value]) => ({
    form: 'inline', file: 'server/routes/preferences.js', key: 'PUT /', method: 'PUT',
    path: '/api/v1/preferences', body: { [field]: value }, expect: ADMIN_REQUIRED, field,
  })),
  { form: 'inline', file: 'server/routes/preferences.js', key: 'POST /holidays/sync', method: 'POST',
    path: '/api/v1/preferences/holidays/sync', body: {}, expect: ADMIN_REQUIRED },
  // A done task whose payment visit is paid: reopening it is for an admin.
  { form: 'inline', file: 'server/routes/tasks.js', key: 'PUT /:id', method: 'PUT',
    path: (s) => `/api/v1/tasks/${s.ids.settledTask}`, body: { status: 'open' }, expect: ADMIN_REQUIRED },
  { form: 'inline', file: 'server/routes/tasks.js', key: 'PATCH /:id/status', method: 'PATCH',
    path: (s) => `/api/v1/tasks/${s.ids.settledTask}/status`, body: { status: 'open' }, expect: ADMIN_REQUIRED },
  { form: 'inline', file: 'server/routes/tasks.js', key: 'GET /points/affected', method: 'GET',
    path: '/api/v1/tasks/points/affected?points=x', expect: ADMIN_REQUIRED },
  { form: 'inline', file: 'server/routes/tasks.js', key: 'POST /points/rebase', method: 'POST',
    path: '/api/v1/tasks/points/rebase', body: { from: 'x', to: 'x' }, expect: ADMIN_REQUIRED },
  // A pending reward redemption of the member: fulfilling is for an admin.
  { form: 'inline', file: 'server/routes/rewards.js', key: 'PATCH /redemptions/:id', method: 'PATCH',
    path: (s) => `/api/v1/rewards/redemptions/${s.ids.pendingRedemption}`, body: { action: 'fulfill' },
    expect: ADMIN_REQUIRED },
  // A redemption its decider fulfilled after the request (no auto-fulfilment):
  // of the deciders only an admin takes it back.
  { form: 'inline', file: 'server/routes/rewards.js', key: 'PATCH /redemptions/:id', method: 'PATCH',
    path: (s) => `/api/v1/rewards/redemptions/${s.ids.decidedRedemption}`, body: { action: 'reopen' },
    expect: REOPEN_NOT_ALLOWED },
  // A local calendar with a feed token: deleting it is for an admin.
  { form: 'inline', file: 'server/routes/calendar/local-calendars.js', key: 'DELETE /calendars/:id', method: 'DELETE',
    path: (s) => `/api/v1/calendar/calendars/${s.ids.feedCalendar}`, expect: FEED_ADMIN_ONLY },
  .../** @type {[string, string, string, unknown?][]} */ ([
    ['GET', '/accounts', '/accounts'],
    ['POST', '/accounts', '/accounts', {}],
    ['DELETE', '/accounts/:id', `/accounts/${NO_ID}`],
    ['POST', '/accounts/:id/test', `/accounts/${NO_ID}/test`, {}],
    ['GET', '/search', '/search'],
    ['GET', '/thumbnail', '/thumbnail'],
    ['POST', '/link', '/link', {}],
    ['POST', '/push', '/push', {}],
  ]).map(([method, key, path, body]) => ({
    form: 'inline', file: 'server/routes/dms.js', key: `${method} ${key}`, method,
    path: `/api/v1/documents/dms${path}`, ...(body ? { body } : {}), expect: ADMIN_REQUIRED,
  })),
  .../** @type {[string, string, string, unknown?][]} */ ([
    ['GET', '/accounts', '/accounts'],
    ['POST', '/accounts', '/accounts', {}],
    ['PATCH', '/accounts/:id', `/accounts/${NO_ID}`, {}],
    ['DELETE', '/accounts/:id', `/accounts/${NO_ID}`],
    ['POST', '/accounts/:id/test', `/accounts/${NO_ID}/test`, {}],
    ['POST', '/accounts/:id/sync', `/accounts/${NO_ID}/sync`, {}],
    ['POST', '/sync', '/sync', {}],
  ]).map(([method, key, path, body]) => ({
    form: 'inline', file: 'server/routes/recipe-providers.js', key: `${method} ${key}`, method,
    path: `/api/v1/recipe-providers${path}`, ...(body ? { body } : {}), expect: ADMIN_REQUIRED,
  })),
  { form: 'inline', file: 'server/routes/documents.js', key: 'GET /storage/config', method: 'GET',
    path: '/api/v1/documents/storage/config', expect: ADMIN_REQUIRED },
  { form: 'inline', file: 'server/routes/documents.js', key: 'PUT /storage/config', method: 'PUT',
    path: '/api/v1/documents/storage/config', body: { selected_upload_backend: 'x' }, expect: ADMIN_REQUIRED },
  { form: 'inline', file: 'server/routes/documents.js', key: 'POST /storage/test', method: 'POST',
    path: '/api/v1/documents/storage/test', body: {}, expect: ADMIN_REQUIRED },
  { form: 'inline', file: 'server/routes/family.js', key: 'PATCH /members/reorder', method: 'PATCH',
    path: '/api/v1/family/members/reorder', body: { order: 'x' }, expect: ADMIN_REQUIRED },
];

/**
 * Gates the suite cannot reach, with the reason. Each still counts as a site.
 * @type {{ form: string, file: string, key: string, reason: string }[]}
 */
export const EXCEPTIONS = [];

/**
 * 403s behind an admin question that are NOT admin gates: "own row or admin".
 * A member who owns the row passes, so a member's answer says nothing about
 * the admin question alone; the route suites named hold them.
 * @type {{ form: string, file: string, key: string, reason: string }[]}
 */
export const MIXED = [
  { form: 'inline', file: 'server/routes/calendar/crud.js', key: 'POST /:id/reset',
    reason: 'creator, subscription owner or admin may reset an ICS event (test:calendar-routes)' },
  { form: 'inline', file: 'server/routes/calendar/subscriptions.js', key: 'POST /subscriptions/:id/sync',
    reason: 'owner or admin may sync a subscription (test:calendar-routes)' },
  { form: 'inline', file: 'server/routes/rewards.js', key: 'PATCH /redemptions/:id',
    reason: 'requester or admin may cancel a redemption (test:rewards-routes)' },
];

/** The cases where an admin gets through (not 403), one per form. */
export const ADMIN_PASSES = [
  { form: 'requireAdmin (shared)', method: 'GET', path: '/api/v1/backup/status' },
  { form: 'requireAdmin (shared, auth router)', method: 'GET', path: '/api/v1/auth/api-tokens' },
  { form: 'requireAdmin (former local copy)', method: 'GET', path: '/api/v1/screensaver/config' },
  { form: 'assertAdmin', method: 'POST', path: '/api/v1/housekeeping/worker', body: {} },
  { form: 'inline', method: 'GET', path: '/api/v1/recipe-providers/accounts' },
  { form: 'inline (preferences)', method: 'PUT', path: '/api/v1/preferences', body: { countdown_grace_days: 3 } },
];

/**
 * An admin on a signed-in device: every form names the device (C2 - one
 * function sends both refusals). Before C2 a local copy answered without the
 * reason and an inline gate with its own text.
 */
export const DEVICE_CASES = [
  { form: 'requireAdmin (shared)', method: 'GET', path: '/api/v1/backup/status', expect: DEVICE_CREDENTIAL },
  { form: 'requireAdmin (former local copy)', method: 'GET', path: '/api/v1/screensaver/config', expect: DEVICE_CREDENTIAL },
  { form: 'inline', method: 'GET', path: '/api/v1/recipe-providers/accounts', expect: DEVICE_CREDENTIAL },
];
