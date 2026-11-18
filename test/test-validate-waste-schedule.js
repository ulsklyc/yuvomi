/**
 * Test: request validation in the waste and schedule modules (#2810, phase 2 section E, group 4)
 * Purpose: the eight route files of waste (server/routes/waste/, 39 routes)
 *          and the four of schedule (schedule.js, schedule-extras.js,
 *          schedule-feed.js, schedule-preferences.js, 32 routes) check every
 *          request against the schema of its operation in the OpenAPI
 *          document (`validateRequest()` in every route) before the handler
 *          runs. Held here against the real routers at their real prefixes, in
 *          the order of server/index.js (express.json, defaultEmptyBody,
 *          /schedule/feed, /schedule/preferences, /schedule/extras, /schedule,
 *          the central error handler):
 *            - REFUSED: garbage per field is a 400 with `reason: 'validation'`
 *              and `fields`; `type_id: true`, `note: true`, `mappings: [null]`
 *              and `color: ""` are a 400 where they were a 500;
 *            - ORDER: a malformed request is a 400 before the 404, 403 and 409
 *              of the handler, a valid one meets the same answer as before;
 *            - RIGHTS ORDER: the owner check of the six collecting schedule
 *              writes (and DELETE /overrides/{dateKey}) stands in front of the
 *              check: a member naming someone else is 403 with the plain
 *              `Forbidden.`, also with a broken rest; naming themselves with a
 *              broken rest is 400; an admin with a broken `user_id` is 400;
 *            - FULL REPRESENTATION: PUT /waste/reminder-settings/{typeId}
 *              requires `enabled`, `offset_days` and `delivery_time`; a body
 *              without them is a 400 and leaves the stored setting standing
 *              (it switched the reminder off and reset lead time and time);
 *            - THE OWN CALLERS: every request public/pages/waste.js,
 *              public/pages/schedule.js and the settings pages send passes,
 *              `include_archived=1`, a URL source without `ics` and the legacy
 *              digit text of ids included;
 *            - ONE SOURCE: the enums of the document are the handler's
 *              constants (server/services/waste-fields.js,
 *              server/services/schedule-fields.js).
 *          The household zone is pinned; no answer asserted here carries a
 *          date derived from the clock.
 * Run: npm run test:validate-waste-schedule
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// The URL source below is a local stand-in, never the network: the opt-in for
// a private address (http://127.0.0.1) is on for the whole suite.
process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: wasteRouter } = await import('../server/routes/waste/index.js');
const { default: scheduleRouter } = await import('../server/routes/schedule.js');
const { default: scheduleExtrasRouter } = await import('../server/routes/schedule-extras.js');
const { default: scheduleFeedRouter } = await import('../server/routes/schedule-feed.js');
const { default: schedulePreferencesRouter } = await import('../server/routes/schedule-preferences.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const wf = await import('../server/services/waste-fields.js');
const sf = await import('../server/services/schedule-fields.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
const FORBIDDEN = { error: 'Forbidden.', code: 403 };

/** @param {string} username @param {string} role */
function user(username, role) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, 'parent')")
    .run(username, username, role).lastInsertRowid);
}
const ADMIN = user('admin4', 'admin');
const ALICE = user('alice4', 'member');
const BOB = user('bob4', 'member');
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = { admin: { id: ADMIN, role: 'admin' }, alice: { id: ALICE, role: 'member' }, bob: { id: BOB, role: 'member' } };

const quiet = { warn: () => {}, error: () => {} };
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(defaultEmptyBody);
// requireAuth, reduced to the fields these routes read.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const actor = ACTORS[req.get('x-actor') ?? 'admin'];
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.authMethod = 'session';
  req.authScopes = null;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
// The mounts of server/index.js, in its order.
app.use('/api/v1/waste', wasteRouter);
app.use('/api/v1/schedule/feed', scheduleFeedRouter);
app.use('/api/v1/schedule/preferences', schedulePreferencesRouter);
app.use('/api/v1/schedule/extras', scheduleExtrasRouter);
app.use('/api/v1/schedule', scheduleRouter);
app.use(createErrorHandler(quiet));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));

// A local stand-in for the address of a URL source. The suite's own calls
// never leave 127.0.0.1; the origin is compared exactly.
/** @type {string} */
let feedBody = '';
const feedServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(feedBody);
});
feedServer.listen(0, '127.0.0.1');
/** @type {string} */
const feedOrigin = await new Promise((r) => feedServer.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (feedServer.address()).port}`)));
assert.equal(new URL(`${feedOrigin}/cal.ics`).origin, feedOrigin);
test.after(() => { server.close(); feedServer.closeAllConnections?.(); feedServer.close(); });

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {{ json?: unknown, actor?: string }} [options] json left out: no body
 */
async function call(method, route, { json, actor } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor) headers['x-actor'] = actor;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api/v1${route}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, body };
}

/**
 * The 400 of the middleware with this field among its fields.
 * @param {{ status: number, body: any }} res
 * @param {string} path
 * @param {string} [rule]
 * @param {string} [label]
 */
function assertRefusedAt(res, path, rule, label = '') {
  assert.equal(res.status, 400, `${label} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, label);
  assert.ok(Array.isArray(res.body.fields), label);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path && (!rule || f.rule === rule)), `${label}: ${JSON.stringify(res.body.fields)}`);
}

/**
 * The schema's own refusal with `reason: 'validation'`.
 * @param {{ status: number, body: any }} res
 * @param {string} path
 * @param {string} [rule]
 * @param {string} [label]
 */
function assertValidation(res, path, rule, label = '') {
  assertRefusedAt(res, path, rule, label);
  assert.equal(res.body.reason, 'validation', label);
}

/** @param {{ status: number, body: any }} res @param {number} status @param {string} [label] */
function assertStatus(res, status, label = '') {
  assert.equal(res.status, status, `${label} ${JSON.stringify(res.body)}`);
  if (status !== 400) assert.notEqual(res.body?.error, SENTENCE, label);
}

const MISSING = 987654;
const ics = (/** @type {string} */ day, label = 'Restmuell') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${label}-${day}@x\r\nSUMMARY:${label}\r\nDTSTART;VALUE=DATE:${day.replace(/-/g, '')}\r\nEND:VEVENT\r\nEND:VCALENDAR`;

// ── Seed through the real routes, in the forms the app sends ─────────────────

/** POST /waste/types as the type dialog (public/pages/waste.js) sends it. */
const type = (await call('POST', '/waste/types', { json: { name: 'Bio', icon: 'leaf', color: '#22C55E' } })).body.data;
const otherType = (await call('POST', '/waste/types', { json: { name: 'Papier', icon: 'trash-2', color: '#3B82F6' } })).body.data;
/** POST /waste/schedules as the schedule dialog sends it. */
const weeklyBody = { type_id: type.id, recurrence_kind: 'weekly', anchor_date: '2027-01-04', interval: 1, valid_until: null, active: true, weekdays: ['MO'] };
const schedule = (await call('POST', '/waste/schedules', { json: weeklyBody })).body.data;
const pickup = (await call('POST', '/waste/pickups', { json: { type_id: type.id, date: '2027-03-01', note: null } })).body.data;
/** A file source through the import wizard. */
const fileSource = (await call('POST', '/waste/import/commit', {
  json: { mappings: [{ normalized_label: 'restmuell', type_ids: [type.id] }], skip_event_keys: [], preview_digest: null, ics: ics('2027-02-01'), name: 'Kalender' },
})).body.data.source;
const mapping = (await call('GET', `/waste/sources/${fileSource.id}`)).body.data.mappings[0];

const shiftType = (await call('POST', '/schedule/shift-types', {
  // formData(form) of the shift dialog: text only, empty fields as "".
  json: { name: 'Frueh', short_code: 'F', start_time: '06:00', end_time: '14:00', color: '#0891B2', icon: '', shift_preset: '' },
})).body.data;
const field = (await call('POST', '/schedule/custom-fields', { json: { name: 'Station' } })).body.data;
await call('PUT', `/schedule/shift-types/${shiftType.id}/fields`, { json: { fields: [{ custom_field_id: field.id, position: 0, show_in_overlay: false }] } });
const alicePattern = (await call('POST', '/schedule/patterns', {
  actor: 'alice',
  json: { mode: 'pattern', user_id: ALICE, name: 'Rota', anchor_date: '2027-01-04', cycle_length: 7, valid_from: '', valid_until: '', is_active: true, note: '', shift_type_id: '', reminder_offset_minutes: '15' },
})).body.data;
const aliceExtra = (await call('POST', '/schedule/extras', {
  actor: 'alice',
  json: { user_id: ALICE, shift_type_id: shiftType.id, note: '', reminder_offset_minutes: null, field_values: {}, date_key: '2027-01-05' },
})).body.data;

// ════════════════════════════════════════════════════════════════════════════
// WASTE
// ════════════════════════════════════════════════════════════════════════════

test('seed: the own callers of the waste page passed', () => {
  assert.ok(type?.id && otherType?.id && schedule?.id && pickup?.id && fileSource?.id && mapping?.id);
});

test('waste: every request the page and the settings send passes', async () => {
  assertStatus(await call('GET', '/waste/types?include_archived=1'), 200);
  assertStatus(await call('GET', '/waste/types'), 200);
  assertStatus(await call('GET', '/waste/schedules'), 200);
  assertStatus(await call('GET', '/waste/occurrences?from=2027-01-01&to=2027-01-31'), 200);
  assertStatus(await call('GET', '/waste/occurrences/next'), 200);
  assertStatus(await call('GET', '/waste/sources'), 200);
  assertStatus(await call('PUT', `/waste/types/${otherType.id}`, { json: { sort_order: 3 } }), 200);
  assertStatus(await call('PUT', `/waste/types/${otherType.id}`, { json: { archived: true } }), 200);
  assertStatus(await call('PUT', `/waste/types/${otherType.id}`, { json: { archived: false } }), 200);
  assertStatus(await call('PUT', `/waste/types/${otherType.id}`, { json: { name: 'Papier', icon: 'trash-2', color: '#3B82F6' } }), 200);
  // The schedule dialog on a kind change: month_day of the old kind is still allowed.
  assertStatus(await call('PUT', `/waste/schedules/${schedule.id}`, { json: { ...weeklyBody, weekdays: ['MO', 'TH'] } }), 200);
  const monthly = await call('POST', '/waste/schedules', { json: { type_id: type.id, recurrence_kind: 'monthly_fixed_day', anchor_date: '2027-01-15', interval: 1, valid_until: null, active: true, month_day: 15 } });
  assertStatus(monthly, 201);
  assertStatus(await call('POST', '/waste/schedules', { json: { type_id: type.id, recurrence_kind: 'monthly_ordinal_weekday', anchor_date: '2027-01-12', interval: 1, valid_until: null, active: true, month_day: 2, weekdays: 'TU' } }), 201);
  // The one-off dialog sends its type along on update (ignored there).
  assertStatus(await call('PUT', `/waste/pickups/${pickup.id}`, { json: { type_id: type.id, date: '2027-03-02', note: 'Sperrmuell' } }), 200);
  assertStatus(await call('GET', `/waste/pickups/${pickup.id}`), 200);
  // Moving and skipping an occurrence (the move dialog may send "").
  assertStatus(await call('PUT', `/waste/schedules/${schedule.id}/overrides/2027-01-04`, { json: { replacement_date: '2027-01-05' } }), 200);
  assertStatus(await call('PUT', `/waste/schedules/${schedule.id}/overrides/2027-01-11`, { json: { replacement_date: null } }), 200);
  assert.equal((await call('PUT', `/waste/schedules/${schedule.id}/overrides/2027-01-18`, { json: { replacement_date: '' } })).body.reason, 'waste_override_date_invalid');
  assertStatus(await call('DELETE', `/waste/schedules/${schedule.id}/overrides/2027-01-04`), 204);
  // An empty body still skips the occurrence.
  assertStatus(await call('PUT', `/waste/schedules/${schedule.id}/overrides/2027-01-25`), 200);
  // Sources: rename, mapping edit, profile round trip, file re-import.
  assertStatus(await call('PUT', `/waste/sources/${fileSource.id}`, { json: { name: 'Kalender 2027' } }), 200);
  assertStatus(await call('PUT', `/waste/sources/${fileSource.id}/mappings/${mapping.id}`, { json: { type_ids: [type.id, otherType.id] } }), 200);
  assertStatus(await call('PUT', `/waste/sources/${fileSource.id}/mappings/${mapping.id}`, { json: { ignored: true } }), 200);
  const exported = (await call('GET', `/waste/sources/${fileSource.id}/mapping-profile/export`)).body.data;
  const profilePreview = await call('POST', `/waste/sources/${fileSource.id}/mapping-profile/import/preview`, { json: { profile: exported } });
  assertStatus(profilePreview, 200);
  assertStatus(await call('POST', `/waste/sources/${fileSource.id}/mapping-profile/import/commit`, { json: { profile: exported, profile_digest: profilePreview.body.data.profile_digest } }), 200);
  // A profile file without `version` passes too: the route never read it.
  assertStatus(await call('POST', `/waste/sources/${fileSource.id}/mapping-profile/import/preview`, { json: { profile: { mappings: [] } } }), 200);
  const reimport = await call('POST', `/waste/sources/${fileSource.id}/reimport/preview`, { json: { ics: ics('2027-02-01') } });
  assertStatus(reimport, 200);
  assertStatus(await call('POST', `/waste/sources/${fileSource.id}/reimport/commit`, {
    json: { mappings: [{ normalized_label: 'restmuell', type_ids: [type.id] }], skip_event_keys: [], preview_digest: reimport.body.data.digest, ics: ics('2027-02-01'), expected_version: reimport.body.data.expected_version },
  }), 200);
  assertStatus(await call('POST', '/waste/import/preview', { json: { ics: ics('2027-04-01') } }), 200);
  // Reminders, feed, feed types.
  assertStatus(await call('GET', '/waste/reminder-settings'), 200);
  assertStatus(await call('PUT', `/waste/reminder-settings/${type.id}`, { json: { enabled: true, offset_days: 2, delivery_time: '19:30' } }), 200);
  assertStatus(await call('GET', '/waste/feed'), 200);
  assertStatus(await call('POST', '/waste/feed/regenerate', { json: {} }), 200);
  assertStatus(await call('PUT', '/waste/feed/types', { json: { type_ids: [type.id] } }), 200);
  assertStatus(await call('PUT', '/waste/feed/types', { json: { type_ids: null } }), 200);
  assertStatus(await call('DELETE', '/waste/feed'), 200);
});

test('waste: a URL source sends no ics to preview and commit, and passes', async () => {
  feedBody = ics('2027-05-03', 'Gelbe Tonne');
  const created = await call('POST', '/waste/sources', { json: { name: 'Stadt', url: `${feedOrigin}/cal.ics`, refresh_interval_minutes: 1440 } });
  assertStatus(created, 201);
  const id = created.body.data.source.id;
  const preview = await call('POST', `/waste/sources/${id}/reimport/preview`, { json: {} });
  assertStatus(preview, 200);
  const commit = await call('POST', `/waste/sources/${id}/reimport/commit`, {
    json: {
      mappings: preview.body.data.labels.map((/** @type {any} */ l) => ({ normalized_label: l.normalized_label, type_ids: [type.id] })),
      skip_event_keys: [], preview_digest: preview.body.data.digest, expected_version: preview.body.data.expected_version,
    },
  });
  assertStatus(commit, 200);
  assertStatus(await call('POST', `/waste/sources/${id}/refresh`, { json: {} }), 200);
  // The manual refresh takes no body: a body is ignored.
  assertStatus(await call('POST', `/waste/sources/${id}/refresh`, { json: { anything: 1 } }), 200);
});

test('waste: legacy digit text of a type id passes, garbage is a 400', async () => {
  const legacy = await call('POST', '/waste/pickups', { json: { type_id: String(type.id), date: '2027-06-01' } });
  assertStatus(legacy, 201);
  for (const bad of ['7abc', '1.5', -1.5, [type.id], { id: 1 }]) {
    assertValidation(await call('POST', '/waste/pickups', { json: { type_id: bad, date: '2027-06-02' } }), 'body/type_id', undefined, JSON.stringify(bad));
  }
});

// Each was a 500 before #2810 (SQLite cannot bind a boolean or an object, a
// null decision has no label, the color column is NOT NULL). Seen red against
// main through a copy of the route files.
test('waste: garbage that was a 500 is a 400 now', async () => {
  for (const bad of [true, {}]) {
    assertValidation(await call('POST', '/waste/schedules', { json: { ...weeklyBody, type_id: bad } }), 'body/type_id', undefined, `POST /schedules type_id ${JSON.stringify(bad)}`);
    assertValidation(await call('PUT', `/waste/schedules/${schedule.id}`, { json: { type_id: bad } }), 'body/type_id', undefined, `PUT /schedules type_id ${JSON.stringify(bad)}`);
    assertValidation(await call('POST', '/waste/pickups', { json: { type_id: bad, date: '2027-06-03' } }), 'body/type_id', undefined, `POST /pickups type_id ${JSON.stringify(bad)}`);
  }
  for (const bad of [true, {}, [1, 2]]) {
    assertValidation(await call('PUT', `/waste/schedules/${schedule.id}/overrides/2027-02-01`, { json: { replacement_date: null, note: bad } }), 'body/note', 'type', `note ${JSON.stringify(bad)}`);
  }
  assertValidation(await call('POST', '/waste/import/commit', { json: { ics: ics('2027-07-01'), name: 'x', mappings: [null] } }), 'body/mappings/0', 'type');
  assertValidation(await call('POST', `/waste/sources/${fileSource.id}/reimport/commit`, { json: { ics: ics('2027-02-01'), mappings: [null], expected_version: 1 } }), 'body/mappings/0', 'type');
  assertValidation(await call('POST', '/waste/types', { json: { name: 'Leer', color: '' } }), 'body/color', 'pattern');
  assertValidation(await call('PUT', `/waste/types/${type.id}`, { json: { color: '' } }), 'body/color', 'pattern');
});

test('waste: switches are booleans - `active: "false"` is a 400 and leaves the schedule running', async () => {
  for (const bad of ['false', 0, 1, [], {}]) {
    assertValidation(await call('PUT', `/waste/schedules/${schedule.id}`, { json: { active: bad } }), 'body/active', 'type', JSON.stringify(bad));
  }
  assert.equal((await call('GET', `/waste/schedules/${schedule.id}`)).body.data.active, 1, 'the refused switch changed nothing');
  assertValidation(await call('PUT', `/waste/types/${type.id}`, { json: { archived: 'true' } }), 'body/archived', 'type');
  assertValidation(await call('PUT', `/waste/sources/${fileSource.id}/mappings/${mapping.id}`, { json: { ignored: 'false' } }), 'body/ignored', 'type');
});

test('waste: PUT /reminder-settings/{typeId} is the whole setting - a partial or mistyped body is a 400 and leaves it standing', async () => {
  const route = `/waste/reminder-settings/${otherType.id}`;
  assertStatus(await call('PUT', route, { json: { enabled: true, offset_days: 3, delivery_time: '07:15' } }), 200);
  const stored = () => db.prepare('SELECT enabled, offset_days, delivery_time FROM waste_reminder_settings WHERE user_id = ? AND type_id = ?').get(ADMIN, otherType.id);
  const before = stored();
  assertValidation(await call('PUT', route, { json: {} }), 'body/enabled', 'required');
  assertValidation(await call('PUT', route, { json: { offset_days: 2 } }), 'body/enabled', 'required');
  assertValidation(await call('PUT', route, { json: { enabled: 'true', offset_days: 1, delivery_time: '08:00' } }), 'body/enabled', 'type');
  assertValidation(await call('PUT', route, { json: { enabled: true, delivery_time: '08:00' } }), 'body/offset_days', 'required');
  assertValidation(await call('PUT', route, { json: { enabled: true, offset_days: 1 } }), 'body/delivery_time', 'required');
  assert.deepEqual(stored(), before, 'no refused body touched the setting');
  // The bounds keep the route's reason.
  const tooFar = await call('PUT', route, { json: { enabled: true, offset_days: wf.MAX_OFFSET_DAYS + 1, delivery_time: '08:00' } });
  assertRefusedAt(tooFar, 'body/offset_days', 'maximum');
  assert.equal(tooFar.body.reason, 'waste_reminder_offset_invalid');
  const noTime = await call('PUT', route, { json: { enabled: true, offset_days: 1, delivery_time: '24:00' } });
  assertRefusedAt(noTime, 'body/delivery_time', 'pattern');
  assert.equal(noTime.body.reason, 'waste_reminder_time_invalid');
});

test('waste: query garbage and doubled values are a 400', async () => {
  for (const q of ['include_archived=yes', 'include_archived=TRUE', 'include_archived=1&include_archived=1']) {
    assertValidation(await call('GET', `/waste/types?${q}`), 'query/include_archived', undefined, q);
  }
  for (const q of ['include_archived=true', 'include_archived=0', 'include_archived=false']) assertStatus(await call('GET', `/waste/types?${q}`), 200, q);
  assertValidation(await call('GET', '/waste/schedules?include_inactive=no'), 'query/include_inactive');
  assertStatus(await call('GET', '/waste/schedules?include_inactive=0'), 200);
  for (const q of ['type_id=abc', 'type_id=1.5', 'type_id=1e2', `type_id=${type.id}&type_id=${type.id}`]) {
    assertValidation(await call('GET', `/waste/schedules?${q}`), 'query/type_id', undefined, q);
    assertValidation(await call('GET', `/waste/pickups?${q}`), 'query/type_id', undefined, q);
  }
  assertStatus(await call('GET', `/waste/pickups?type_id=${type.id}`), 200);
  assertValidation(await call('GET', '/waste/occurrences?to=2027-01-31'), 'query/from', 'required');
  assertValidation(await call('GET', '/waste/occurrences?from=2027-1-1&to=2027-01-31'), 'query/from', 'pattern');
  assertValidation(await call('GET', '/waste/occurrences?from=2027-01-01&from=2027-01-02&to=2027-01-31'), 'query/from');
});

test('waste: path ids are plain decimal digits', async () => {
  for (const id of ['12abc', '5.0', '1e2', '0x10']) {
    assertValidation(await call('GET', `/waste/types/${id}`), 'path/id', 'type', id);
    assertValidation(await call('DELETE', `/waste/sources/${id}`), 'path/id', 'type', id);
    assertValidation(await call('PUT', `/waste/sources/${fileSource.id}/mappings/${id}`, { json: { ignored: true } }), 'path/mappingId', 'type', id);
    assertValidation(await call('PUT', `/waste/reminder-settings/${id}`, { json: { enabled: false, offset_days: 1, delivery_time: '08:00' } }), 'path/typeId', 'type', id);
  }
  assertValidation(await call('DELETE', `/waste/schedules/${schedule.id}/overrides/someday`), 'path/originalDate', 'pattern');
});

test('waste order changes: a malformed request is a 400 before the 404 and 409, a valid one meets the old answer', async () => {
  const pairs = [
    ['PUT', `/waste/types/${MISSING}`, { name: 5 }, { name: 'x' }, 404],
    ['PUT', `/waste/schedules/${MISSING}`, { active: 'yes' }, { active: false }, 404],
    ['PUT', `/waste/schedules/${MISSING}/overrides/2027-01-04`, { note: true }, { replacement_date: null }, 404],
    ['PUT', `/waste/pickups/${MISSING}`, { date: 20270101 }, { date: '2027-03-01' }, 404],
    ['PUT', `/waste/sources/${MISSING}`, { name: ['x'] }, { name: 'x' }, 404],
    ['POST', `/waste/sources/${MISSING}/mapping-profile/import/preview`, { profile: 'nope' }, { profile: { mappings: [] } }, 404],
    ['POST', `/waste/sources/${MISSING}/mapping-profile/import/commit`, { profile: { mappings: [] } }, { profile: { mappings: [] }, profile_digest: 'x' }, 404],
    ['PUT', `/waste/sources/${fileSource.id}/mappings/${MISSING}`, { type_ids: ['1'] }, { ignored: true }, 404],
    ['POST', `/waste/sources/${MISSING}/reimport/preview`, { ics: 5 }, { ics: ics('2027-02-01') }, 404],
    ['POST', `/waste/sources/${MISSING}/reimport/commit`, { ics: ics('2027-02-01') }, { ics: ics('2027-02-01'), expected_version: 1 }, 404],
    ['PUT', '/waste/feed/types', { type_ids: 'all' }, { type_ids: null }, 404],
  ];
  for (const [method, route, bad, good, status] of pairs) {
    const refused = await call(/** @type {string} */ (method), /** @type {string} */ (route), { json: bad });
    assert.equal(refused.status, 400, `${method} ${route} ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, SENTENCE, `${method} ${route}`);
    assertStatus(await call(/** @type {string} */ (method), /** @type {string} */ (route), { json: good }), /** @type {number} */ (status), `${method} ${route}`);
  }
  // DELETE of an override: a date of the wrong shape was a 404, it is a 400 now.
  assertValidation(await call('DELETE', `/waste/schedules/${MISSING}/overrides/not-a-day`), 'path/originalDate', 'pattern');
  assertStatus(await call('DELETE', `/waste/schedules/${MISSING}/overrides/2027-01-04`), 404);
  // 409: a profile commit without its digest was a 409, it is a 400 now.
  assertValidation(await call('POST', `/waste/sources/${fileSource.id}/mapping-profile/import/commit`, { json: { profile: { mappings: [] } } }), 'body/profile_digest', 'required');
  assertStatus(await call('POST', `/waste/sources/${fileSource.id}/mapping-profile/import/commit`, { json: { profile: { mappings: [] }, profile_digest: 'stale' } }), 409);
  // A re-import commit without its version was a 409 (source_changed), it is a 400 now.
  assertValidation(await call('POST', `/waste/sources/${fileSource.id}/reimport/commit`, { json: { ics: ics('2027-02-01'), mappings: [] } }), 'body/expected_version', 'required');
});

test('waste: the shape rules of a mapping profile keep their reason', async () => {
  const preview = (/** @type {unknown} */ profile) => call('POST', `/waste/sources/${fileSource.id}/mapping-profile/import/preview`, { json: { profile } });
  for (const bad of ['text', [], { mappings: 'x' }, { mappings: [null] }, { mappings: [{ pattern: 'a' }] }, { mappings: [{ pattern: 1, type_name: 'x' }] }]) {
    const r = await preview(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.reason, 'waste_profile_invalid', `${JSON.stringify(bad)} ${JSON.stringify(r.body)}`);
  }
  const noProfile = await call('POST', `/waste/sources/${fileSource.id}/mapping-profile/import/preview`, { json: {} });
  assert.equal(noProfile.body.reason, 'waste_profile_invalid');
  assertValidation(await preview({ version: 2, mappings: [] }), 'body/profile/version', 'enum');
});

test('waste: weekdays as an array or one code; month_day of a weekly plan still stored as null', async () => {
  assertStatus(await call('POST', '/waste/schedules', { json: { ...weeklyBody, weekdays: 'TU' } }), 201);
  const withDay = await call('POST', '/waste/schedules', { json: { ...weeklyBody, month_day: 4 } });
  assertStatus(withDay, 201);
  assert.equal(withDay.body.data.month_day, null);
  // Comma text: no own caller sends it (the dialog sends an array).
  for (const bad of ['MO,TH', 'MO,', 'mo', 'MO TH', ['XX'], 5]) {
    assertValidation(await call('POST', '/waste/schedules', { json: { ...weeklyBody, weekdays: bad } }), 'body/weekdays', undefined, JSON.stringify(bad));
  }
  assertValidation(await call('POST', '/waste/schedules', { json: { ...weeklyBody, recurrence_kind: 'yearly' } }), 'body/recurrence_kind', 'enum');
  assertValidation(await call('POST', '/waste/schedules', { json: { ...weeklyBody, interval: '2' } }), 'body/interval', 'type');
  const zero = await call('POST', '/waste/schedules', { json: { ...weeklyBody, interval: 0 } });
  assertRefusedAt(zero, 'body/interval', 'minimum');
  assert.equal(zero.body.reason, 'waste_schedule_interval_invalid');
});

test('waste: lengths are the route\'s, counted as sent', async () => {
  assertValidation(await call('POST', '/waste/types', { json: { name: 'x'.repeat(wf.TYPE_NAME_MAX + 1) } }), 'body/name', 'maxLength');
  assertStatus(await call('POST', '/waste/types', { json: { name: 'y'.repeat(wf.TYPE_NAME_MAX) } }), 201);
  assertValidation(await call('POST', '/waste/pickups', { json: { type_id: type.id, date: '2027-08-01', note: 'n'.repeat(wf.NOTE_MAX + 1) } }), 'body/note', 'maxLength');
  // The override note has no limit at the route, and none in the schema.
  assertStatus(await call('PUT', `/waste/schedules/${schedule.id}/overrides/2027-03-01`, { json: { replacement_date: null, note: 'n'.repeat(5000) } }), 200);
  assertValidation(await call('PUT', `/waste/sources/${fileSource.id}`, { json: { name: 's'.repeat(wf.SOURCE_NAME_MAX + 1) } }), 'body/name', 'maxLength');
});

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULE
// ════════════════════════════════════════════════════════════════════════════

test('seed: the own callers of the schedule page passed', () => {
  assert.ok(shiftType?.id && field?.id && alicePattern?.id && aliceExtra?.id, JSON.stringify({ shiftType, field, alicePattern, aliceExtra }));
});

test('schedule: every request the page and the settings send passes', async () => {
  for (const route of ['/schedule/shift-types', '/schedule/custom-fields', '/schedule/patterns', '/schedule/overrides', '/schedule/extras', '/schedule/preferences', '/schedule/household-members', '/schedule/feed']) {
    assertStatus(await call('GET', route), 200, route);
  }
  assertStatus(await call('GET', '/schedule/entries?from=2027-01-01&to=2027-01-31'), 200);
  assertStatus(await call('GET', `/schedule/entries?from=2027-01-01&to=2027-01-31&user_id=${ALICE}`), 200);
  assertStatus(await call('GET', `/schedule/patterns/${alicePattern.id}/days`), 200);
  // formData(form) of the edit dialogs: text only.
  assertStatus(await call('PUT', `/schedule/shift-types/${shiftType.id}`, { json: { name: 'Frueh', short_code: '', start_time: '06:00', end_time: '14:00', color: '#0891B2', icon: 'sun' } }), 200);
  assertStatus(await call('PUT', `/schedule/custom-fields/${field.id}`, { json: { name: 'Station 2' } }), 200);
  assertStatus(await call('PUT', `/schedule/patterns/${alicePattern.id}`, {
    actor: 'alice', json: { name: 'Rota', anchor_date: '2027-01-04', cycle_length: 7, valid_from: '', valid_until: '', is_active: true, user_id: String(ALICE) },
  }), 200);
  assertStatus(await call('PUT', `/schedule/patterns/${alicePattern.id}/days`, {
    actor: 'alice', json: { days: [{ position: 0, shift_type_id: shiftType.id, field_values: { [field.id]: 'A' } }, { position: 1, shift_type_id: null, field_values: {} }] },
  }), 200);
  assertStatus(await call('PUT', '/schedule/overrides/2027-01-06', { actor: 'alice', json: { user_id: ALICE, shift_type_id: null, note: '', field_values: {} } }), 200);
  assertStatus(await call('POST', '/schedule/overrides/fill', { actor: 'alice', json: { user_id: ALICE, from: '2027-01-07', to: '2027-01-08', shift_type_id: shiftType.id, note: 'Urlaub', field_values: { [field.id]: 'B' } } }), 200);
  assertStatus(await call('DELETE', `/schedule/overrides?user_id=${ALICE}&from=2027-01-07&to=2027-01-08`, { actor: 'alice' }), 200);
  assertStatus(await call('POST', '/schedule/extras/fill', { actor: 'alice', json: { user_id: ALICE, shift_type_id: shiftType.id, note: '', reminder_offset_minutes: 30, field_values: {}, from: '2027-01-10', to: '2027-01-11' } }), 200);
  assertStatus(await call('PUT', `/schedule/extras/${aliceExtra.id}`, { actor: 'alice', json: { note: 'Bereitschaft', reminder_offset_minutes: null } }), 200);
  // The settings page sends one key at a time.
  assertStatus(await call('PUT', '/schedule/preferences', { actor: 'alice', json: { reminderOffsetMinutes: 15 } }), 200);
  assertStatus(await call('PUT', '/schedule/preferences', { actor: 'alice', json: { reminderOffsetMinutes: null } }), 200);
  assertStatus(await call('PUT', '/schedule/preferences', { actor: 'alice', json: { weeklyHours: 38 } }), 200);
  assertStatus(await call('PUT', '/schedule/preferences', { actor: 'alice', json: { overtimeEnabled: false } }), 200);
  assertStatus(await call('POST', '/schedule/feed/regenerate', { actor: 'alice' }), 200);
  assertStatus(await call('DELETE', '/schedule/feed', { actor: 'alice' }), 200);
  // Legacy digit text of ids.
  assertStatus(await call('PUT', '/schedule/overrides/2027-01-12', { actor: 'alice', json: { user_id: String(ALICE), shift_type_id: String(shiftType.id) } }), 200);
});

test('schedule: garbage per field is a 400', async () => {
  const cases = [
    ['POST', '/schedule/shift-types', { name: 5 }, 'body/name', 'type'],
    ['POST', '/schedule/shift-types', { name: 'x', start_time: '6:00', end_time: '14:00' }, 'body/start_time', 'pattern'],
    ['POST', '/schedule/shift-types', { name: 'x', color: 'red' }, 'body/color', 'pattern'],
    ['POST', '/schedule/shift-types', { name: 'x', short_code: 'x'.repeat(sf.MAX_SHORT_CODE + 1) }, 'body/short_code', 'maxLength'],
    ['POST', '/schedule/custom-fields', { name: ['x'] }, 'body/name', 'type'],
    ['POST', '/schedule/patterns', { name: 'x', anchor_date: '2027-01-04', cycle_length: '7' }, 'body/cycle_length', 'type'],
    ['POST', '/schedule/patterns', { name: 'x', anchor_date: '2027-01-04', cycle_length: 7, is_active: 'true' }, 'body/is_active', 'type'],
    ['PUT', `/schedule/shift-types/${shiftType.id}/fields`, { fields: [{ custom_field_id: field.id, position: '1' }] }, 'body/fields/0/position', 'type'],
    ['PUT', `/schedule/shift-types/${shiftType.id}/fields`, { fields: [{ custom_field_id: field.id, position: 0, show_in_overlay: null }] }, 'body/fields/0/show_in_overlay', 'type'],
    ['PUT', `/schedule/patterns/${alicePattern.id}/days`, { days: [{ position: [] }] }, 'body/days/0/position', 'type'],
    ['PUT', `/schedule/patterns/${alicePattern.id}/days`, { days: [{ position: 0, shift_type_id: shiftType.id, field_values: { abc: 'x' } }] }, 'body/days/0/field_values', 'propertyNames'],
    ['PUT', '/schedule/overrides/2027-01-13', { note: 5 }, 'body/note', 'type'],
    ['PUT', '/schedule/overrides/2027-02-30x', {}, 'path/dateKey', 'pattern'],
    ['POST', '/schedule/extras', { date_key: '2027-01-14', shift_type_id: shiftType.id, reminder_offset_minutes: '15' }, 'body/reminder_offset_minutes', 'type'],
    ['PUT', '/schedule/preferences', { reminderOffsetMinutes: '' }, 'body/reminderOffsetMinutes', 'type'],
    ['PUT', '/schedule/preferences', { weeklyHours: [40] }, 'body/weeklyHours', 'type'],
    ['PUT', '/schedule/preferences', { overtimeEnabled: 1 }, 'body/overtimeEnabled', 'type'],
  ];
  for (const [method, route, json, path, rule] of cases) {
    assertValidation(await call(/** @type {string} */ (method), /** @type {string} */ (route), { json }), /** @type {string} */ (path), /** @type {string} */ (rule), `${method} ${route} ${JSON.stringify(json)}`);
  }
  for (const q of ['user_id=abc', 'user_id=1&user_id=2', 'user_id=']) {
    assertValidation(await call('GET', `/schedule/patterns?${q}`), 'query/user_id', undefined, q);
    assertValidation(await call('GET', `/schedule/extras?${q}`), 'query/user_id', undefined, q);
    assertValidation(await call('GET', `/schedule/overrides?${q}`), 'query/user_id', undefined, q);
  }
  assertValidation(await call('GET', '/schedule/overrides?from=soon'), 'query/from', 'pattern');
  assertStatus(await call('GET', '/schedule/overrides?from=&to='), 200);
  assertValidation(await call('GET', '/schedule/entries?from=2027-01-01'), 'query/to', 'required');
  for (const id of ['12abc', '5.0', '1e2']) {
    assertValidation(await call('DELETE', `/schedule/extras/${id}`), 'path/id', 'type', id);
    assertValidation(await call('PUT', `/schedule/shift-types/${id}`, { json: {} }), 'path/id', 'type', id);
  }
});

test('schedule rights order: the collecting writes refuse a foreign user_id before the check', async () => {
  const routes = [
    ['POST', '/schedule/patterns', { name: 5, anchor_date: 'x', cycle_length: 7 }, { name: 'x', anchor_date: '2027-01-04', cycle_length: 7 }],
    ['PUT', '/schedule/overrides/2027-01-20', { note: 5 }, {}],
    ['POST', '/schedule/overrides/fill', { from: 'x', to: '2027-01-21' }, { from: '2027-01-20', to: '2027-01-21' }],
    ['POST', '/schedule/extras', { date_key: 'x', shift_type_id: shiftType.id }, { date_key: '2027-01-20', shift_type_id: shiftType.id }],
    ['POST', '/schedule/extras/fill', { from: 'x', to: '2027-01-21', shift_type_id: shiftType.id }, { from: '2027-01-20', to: '2027-01-21', shift_type_id: shiftType.id }],
  ];
  for (const [method, route, broken, valid] of /** @type {Array<[string, string, Record<string, unknown>, Record<string, unknown>]>} */ (routes)) {
    const label = `${method} ${route}`;
    // A member naming someone else: 403 with the plain sentence, also with a broken rest.
    for (const foreign of [BOB, String(BOB), 1.5, '7abc', [ALICE]]) {
      const r = await call(/** @type {string} */ (method), /** @type {string} */ (route), { actor: 'alice', json: { ...broken, user_id: foreign } });
      assert.equal(r.status, 403, `${label} ${JSON.stringify(foreign)} ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, FORBIDDEN, label);
    }
    // Naming themselves (number or digit text) with a broken rest: the 400 of the check.
    for (const own of [ALICE, String(ALICE)]) {
      const r = await call(/** @type {string} */ (method), /** @type {string} */ (route), { actor: 'alice', json: { ...broken, user_id: own } });
      assert.equal(r.status, 400, `${label} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, SENTENCE, label);
      assert.ok(!r.body.fields.some((/** @type {any} */ f) => f.path === 'body/user_id'), label);
    }
    // An admin with a broken user_id: the 400 of the check.
    const admin = await call(/** @type {string} */ (method), /** @type {string} */ (route), { actor: 'admin', json: { ...broken, user_id: '7abc' } });
    assert.equal(admin.status, 400, `${label} ${JSON.stringify(admin.body)}`);
    assert.equal(admin.body.error, SENTENCE, label);
    // With only the user_id broken, the check names it.
    assertValidation(await call(/** @type {string} */ (method), /** @type {string} */ (route), { actor: 'admin', json: { ...valid, user_id: '7abc' } }), 'body/user_id', undefined, label);
  }
  // The two deletes read user_id from the query.
  for (const route of ['/schedule/overrides?from=x&to=2027-01-21', '/schedule/overrides/2027-01-21']) {
    for (const foreign of [String(BOB), '7abc', '']) {
      const sep = route.includes('?') ? '&' : '?';
      const r = await call('DELETE', `${route}${sep}user_id=${foreign}`, { actor: 'alice' });
      assert.deepEqual({ status: r.status, body: r.body }, { status: 403, body: FORBIDDEN }, `${route} ${foreign}`);
    }
    const sep = route.includes('?') ? '&' : '?';
    const admin = await call('DELETE', `${route}${sep}user_id=7abc`, { actor: 'admin' });
    assertValidation(admin, 'query/user_id', 'type', route);
  }
  // The handler's own check stays behind: an admin writes for anyone.
  assertStatus(await call('PUT', '/schedule/overrides/2027-01-22', { actor: 'admin', json: { user_id: BOB, shift_type_id: null } }), 200);
});

// The own id with a digit prefix is not the own id: parseInt would read
// `"<id>abc"` as <id>, the middleware must not. Digit text of the own id is
// the legacy form and passes.
test('schedule rights order: a digit-prefix form of the own id is foreign, digit text of the own id passes', async () => {
  const prefixForms = [`${ALICE}abc`, `${ALICE}.0`, ` ${ALICE}`, `${ALICE}e0`];
  for (const form of prefixForms) {
    const body = await call('PUT', '/schedule/overrides/2027-01-23', { actor: 'alice', json: { user_id: form, shift_type_id: null } });
    assert.deepEqual({ status: body.status, body: body.body }, { status: 403, body: FORBIDDEN }, `body ${JSON.stringify(form)}`);
    const query = await call('DELETE', `/schedule/overrides/2027-01-23?user_id=${encodeURIComponent(form)}`, { actor: 'alice' });
    assert.deepEqual({ status: query.status, body: query.body }, { status: 403, body: FORBIDDEN }, `query ${JSON.stringify(form)}`);
  }
  assertStatus(await call('PUT', '/schedule/overrides/2027-01-23', { actor: 'alice', json: { user_id: String(ALICE), shift_type_id: null } }), 200, 'own digit text in the body');
  assertStatus(await call('DELETE', `/schedule/overrides/2027-01-23?user_id=${ALICE}`, { actor: 'alice' }), 204, 'own digit text in the query');
});

test('schedule order changes: a malformed request is a 400 before the 404 and 403, a valid one meets the old answer', async () => {
  // Bob's rows, which alice may not change.
  const bobPattern = (await call('POST', '/schedule/patterns', { actor: 'bob', json: { user_id: BOB, name: 'B', anchor_date: '2027-01-04', cycle_length: 7 } })).body.data;
  const bobExtra = (await call('POST', '/schedule/extras', { actor: 'bob', json: { user_id: BOB, date_key: '2027-01-05', shift_type_id: shiftType.id } })).body.data;
  const adminType = shiftType; // created by the admin
  const cases = [
    ['PUT', `/schedule/shift-types/${MISSING}`, { name: 5 }, { name: 'x' }, 'admin', 404],
    ['PUT', `/schedule/shift-types/${adminType.id}`, { name: 5 }, { name: 'x' }, 'alice', 403],
    ['PUT', `/schedule/shift-types/${MISSING}/fields`, { fields: 'x' }, { fields: [] }, 'admin', 404],
    ['PUT', `/schedule/shift-types/${adminType.id}/fields`, { fields: 'x' }, { fields: [] }, 'alice', 403],
    ['PUT', `/schedule/custom-fields/${MISSING}`, { name: 5 }, { name: 'x' }, 'admin', 404],
    ['PUT', `/schedule/custom-fields/${field.id}`, { name: 5 }, { name: 'x' }, 'alice', 403],
    ['PUT', `/schedule/patterns/${MISSING}`, { is_active: 'no' }, { name: 'x' }, 'admin', 404],
    ['PUT', `/schedule/patterns/${bobPattern.id}`, { is_active: 'no' }, { name: 'x' }, 'alice', 403],
    ['PUT', `/schedule/patterns/${MISSING}/days`, { days: 'x' }, { days: [] }, 'admin', 404],
    ['PUT', `/schedule/patterns/${bobPattern.id}/days`, { days: 'x' }, { days: [] }, 'alice', 403],
    ['PUT', `/schedule/extras/${MISSING}`, { note: 5 }, { note: 'x' }, 'admin', 404],
    ['PUT', `/schedule/extras/${bobExtra.id}`, { note: 5 }, { note: 'x' }, 'alice', 403],
  ];
  for (const [method, route, bad, good, actor, status] of cases) {
    const label = `${method} ${route} as ${actor}`;
    const refused = await call(/** @type {string} */ (method), /** @type {string} */ (route), { actor: /** @type {string} */ (actor), json: bad });
    assert.equal(refused.status, 400, `${label} ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, SENTENCE, label);
    assertStatus(await call(/** @type {string} */ (method), /** @type {string} */ (route), { actor: /** @type {string} */ (actor), json: good }), /** @type {number} */ (status), label);
  }
});

test('schedule: partial updates take null where the route clears, never where it refuses', async () => {
  assertStatus(await call('PUT', `/schedule/shift-types/${shiftType.id}`, { json: { short_code: null, icon: null, color: null, start_time: null, end_time: null } }), 200);
  assertValidation(await call('PUT', `/schedule/shift-types/${shiftType.id}`, { json: { name: null } }), 'body/name', 'type');
  assertStatus(await call('PUT', `/schedule/patterns/${alicePattern.id}`, { actor: 'alice', json: { valid_from: null, valid_until: null } }), 200);
  assertValidation(await call('PUT', `/schedule/patterns/${alicePattern.id}`, { actor: 'alice', json: { name: null } }), 'body/name', 'type');
  assertStatus(await call('PUT', `/schedule/extras/${aliceExtra.id}`, { actor: 'alice', json: { note: null, reminder_offset_minutes: null } }), 200);
  assertValidation(await call('PUT', `/schedule/extras/${aliceExtra.id}`, { actor: 'alice', json: { date_key: null } }), 'body/date_key', 'type');
  // A missing shift type on an extra keeps its own reason.
  const noType = await call('POST', '/schedule/extras', { actor: 'alice', json: { date_key: '2027-01-15' } });
  assertRefusedAt(noType, 'body/shift_type_id', 'required');
  assert.equal(noType.body.reason, 'schedule_shift_type_required');
});

// ════════════════════════════════════════════════════════════════════════════
// ONE SOURCE
// ════════════════════════════════════════════════════════════════════════════

test('one source: the enums of the document are the handler\'s constants', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const schemas = spec.components.schemas;
  const set = (/** @type {readonly unknown[]} */ values) => [...new Set(values)].sort();
  assert.deepEqual(set(schemas.WasteScheduleInput.properties.recurrence_kind.enum), set(wf.RECURRENCE_KINDS));
  assert.deepEqual(set(schemas.WasteScheduleUpdateInput.properties.recurrence_kind.enum), set(wf.RECURRENCE_KINDS));
  assert.deepEqual(set(schemas.WasteScheduleInput.properties.weekdays.anyOf[0].items.enum), set(wf.WEEKDAY_CODES));
  assert.deepEqual(set(schemas.WasteScheduleInput.properties.weekdays.anyOf[1].enum.filter((/** @type {unknown} */ v) => v !== null)), set(wf.WEEKDAY_CODES));
  assert.deepEqual(schemas.WasteMappingProfileInput.properties.version.enum, [wf.MAPPING_PROFILE_VERSION]);
  const types = spec.paths['/api/v1/waste/types'].get.parameters.find((/** @type {any} */ p) => p.name === 'include_archived');
  const schedules = spec.paths['/api/v1/waste/schedules'].get.parameters.find((/** @type {any} */ p) => p.name === 'include_inactive');
  assert.deepEqual(set(types.schema.enum), set(wf.QUERY_FLAG_VALUES));
  assert.deepEqual(set(schedules.schema.enum), set(wf.QUERY_FLAG_VALUES));
  const reminder = schemas.WasteReminderSettingUpdateInput.properties.offset_days;
  assert.deepEqual([reminder.minimum, reminder.maximum], [wf.MIN_OFFSET_DAYS, wf.MAX_OFFSET_DAYS]);
  const prefs = spec.paths['/api/v1/schedule/preferences'].put.requestBody.content['application/json'].schema.properties;
  assert.deepEqual([prefs.weeklyHours.minimum, prefs.weeklyHours.maximum], [sf.MIN_WEEKLY_HOURS, sf.MAX_WEEKLY_HOURS]);
  assert.equal(prefs.reminderOffsetMinutes.maximum, sf.MAX_REMINDER_OFFSET_MINUTES);
  const days = spec.paths['/api/v1/schedule/patterns/{id}/days'].put.requestBody.content['application/json'].schema.properties.days;
  assert.equal(days.maxItems, sf.MAX_PATTERN_DAY_ROWS);
});

test('one source: the export writes the profile version the document accepts', async () => {
  const exported = (await call('GET', `/waste/sources/${fileSource.id}/mapping-profile/export`)).body.data;
  assert.equal(exported.version, wf.MAPPING_PROFILE_VERSION);
});
