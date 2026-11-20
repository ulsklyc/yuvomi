/**
 * Test: request validation in health (#2810, phase 2 section E, group 6)
 * Purpose: the twelve route files under server/routes/health/ (85 routes)
 *          check every request against the schema of its operation in the
 *          OpenAPI document (`validateRequest()` in every route) before the
 *          handler runs. Held here against the real health router at its real
 *          prefix `/api/v1/health`, in the order of server/index.js
 *          (express.json, defaultEmptyBody, the router, the central error
 *          handler; test/health-app.js):
 *            - THE OWN CALLERS: the requests public/pages/health.js,
 *              health-fasting.js, components/fasting-controls.js and the
 *              settings pages (personal-health, modules-health, admin-family,
 *              personal-feeds) send pass, ids as numbers and as legacy digit
 *              text; the cycle day log with `""` for a choice not pressed
 *              (that the page sends the preventive-care type as a number is
 *              held in test:health-errors, where the dialog runs);
 *            - REFUSED: garbage per field is a 400 with `reason: 'validation'`
 *              and `fields`: a path id that is not plain decimal digits
 *              (`0x10` hit row 16 before), a number as text, a truth value or
 *              a list in a number field (`"0x10"`, `[]`, `" "` and `true`
 *              were stored as 16, 0, 0 and 1), text in a switch, a value
 *              outside its list (several fell back silently), a number in a
 *              text field, `caregiver_ids: ["abc"]` (withdrew all care), query
 *              garbage (`user_id=abc` read as "everybody", `active=maybe`
 *              ignored), `visibility: null` at PATCH /fasting/{id} (set
 *              `private` silently);
 *            - ORDER: a malformed request is a 400 before the 404 and 409 of
 *              the handler; the rights without a row stand in front: the
 *              fasting capability (403 `FASTING_CAPABILITY_REQUIRED`) on every
 *              fasting route and on the `fasting` area of the visibility
 *              defaults, `requireAdmin` on the caregivers and the
 *              preventive-care types;
 *            - THE SINK: `validateBasalTemp()` looks up only own keys, so
 *              `basal_temp_unit: "constructor"` is refused by the handler
 *              itself, not only by the schema in front of it;
 *            - ONE SOURCE: every list of the schemas is the constant the
 *              handler reads.
 *          The household zone is pinned; no answer asserted here carries a
 *          date of the clock.
 * Run: npm run test:validate-health
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js).
process.env.MODULES_DIR = tempDir('yuvomi-validate-health-');

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthApp } from './health-app.js';

const dbmod = await import('../server/db.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const fields = await import('../server/services/health-fields.js');
const cycleLists = await import('../public/utils/health-cycle.js');
const { validateBasalTemp } = await import('../server/routes/health/cycle.js');
const { default: healthRouter } = await import('../server/routes/health.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';

/** @param {string} username @param {string} role */
function user(username, role) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, 'parent')")
    .run(username, username, role).lastInsertRowid);
}
const ADMIN = user('admin6', 'admin');
const MEM = user('mem6', 'member');
const NOFAST = user('nofast6', 'member');
const PARTNER = user('partner6', 'member');
db.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'none')")
  .run(String(NOFAST));
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  nofast: { id: NOFAST, role: 'member' },
};

const app = await createHealthApp({
  jsonLimit: '10mb',
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = 'session';
    req.session = { userId: actor.id, role: actor.role };
    next();
  },
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} route under /api/v1/health
 * @param {{ json?: unknown, actor?: string }} [options] json left out: no body
 */
async function call(method, route, { json, actor } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor !== undefined) headers['x-actor'] = actor;
  /** @type {any} */
  let payload;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(`${baseUrl}/api/v1/health${route}`, { method, headers, body: payload });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, body };
}

/**
 * A refusal of the schema: 400, the fixed sentence, `reason: validation` and
 * the field named.
 * @param {{ status: number, body: any }} res
 * @param {string} path e.g. `body/value_num`
 * @param {string} label
 */
function refused(res, path, label) {
  assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, label);
  assert.equal(res.body?.reason, 'validation', label);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path), `${label}: ${JSON.stringify(res.body.fields)}`);
}

/**
 * A request the route takes: not a 400 and not a 500.
 * @param {{ status: number, body: any }} res
 * @param {string} label
 */
function accepted(res, label) {
  assert.ok(res.status < 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
}

// ---------------------------------------------------------------------------
// Fixture: one row of each kind, owned by the admin.
// ---------------------------------------------------------------------------

const vital = (await call('POST', '/vitals', { json: { type: 'weight', value_num: 80, unit: 'kg', measured_at: '2026-09-01T08:00', visibility: 'private' } })).body.data;
const med = (await call('POST', '/medications', { json: { name: 'Ibuprofen', active: 1, prn: 0, stock_qty: 20, schedules: [{ time_of_day: '08:00', days_mask: null, dose_qty: 1 }] } })).body.data;
const schedule = med.schedules[0];
const doseLog = (await call('POST', `/medications/${med.id}/logs`, { json: { status: 'pending', scheduled_at: '2026-09-01T08:00', schedule_id: schedule.id } })).body.data;
const report = (await call('POST', '/labs', { json: { report_date: '2026-09-01', visibility: 'private' } })).body.data;
const result = (await call('POST', `/labs/${report.id}/results`, { json: { analyte: 'HbA1c', value_num: 5.4 } })).body.data;
const activity = (await call('POST', '/activities', { json: { type: 'run', performed_at: '2026-09-01T07:00', visibility: 'private' } })).body.data;
const period = (await call('POST', '/cycle/periods', { json: { start_date: '2026-08-20' } })).body.data;
const preventionType = (await call('POST', '/prevention/types', { json: { name: 'Tetanus', kind: 'vaccination', icon: 'syringe' } })).body.data;
const record = (await call('POST', '/prevention/records', { json: { type_id: preventionType.id, given_on: '2026-01-10', visibility: 'private' } })).body.data;
const entry = (await call('POST', '/nutrition/entries', { json: { title: 'Muesli', consumed_at: '2026-09-01T07:30', meal_type: 'breakfast', visibility: 'private' } })).body.data;
const fast = (await call('POST', '/fasting', { json: { start_at: '2025-02-01T08:00:00Z', end_at: '2025-02-01T20:00:00Z', start_tzid: 'Europe/Berlin', goal_minutes: 720, rating: 4, note: '', visibility: 'private', acknowledge_safety: true } })).body.data;

test('fixture: one row of each kind exists', () => {
  for (const [name, row] of Object.entries({ vital, med, schedule, doseLog, report, result, activity, period, preventionType, record, entry, fast })) {
    assert.ok(Number.isInteger(row?.id), `${name} created`);
  }
});

test('every route of the health router carries validateRequest(): 85', () => {
  let routes = 0;
  let checked = 0;
  for (const layer of /** @type {any} */ (healthRouter).stack) {
    for (const inner of layer.handle?.stack ?? []) {
      if (!inner.route) continue;
      routes++;
      if (inner.route.stack.some((/** @type {any} */ l) => l.name === 'validateRequestMiddleware')) checked++;
    }
  }
  assert.equal(routes, 85);
  assert.equal(checked, 85);
});

// ---------------------------------------------------------------------------
// Die eigenen Aufrufer: was die Seiten schicken, geht durch.
// ---------------------------------------------------------------------------

test('own callers: the lists and their queries', async () => {
  for (const route of [
    '/vitals', `/vitals?user_id=${ADMIN}`, '/medications', `/medications?user_id=${ADMIN}&include=schedules,logs&logs_from=2026-08-01T00:00&logs_to=2026-09-01T23:59`,
    '/medications?active=1', '/labs', '/activities', '/prevention/types', '/prevention/records', '/prevention/due', `/prevention/due?user_id=${ADMIN}`,
    '/nutrition/entries', '/nutrition/summary', `/nutrition/summary?user_id=${ADMIN}`, '/cycle/periods', '/cycle/logs', '/cycle/settings',
    '/cycle/feed', '/caregivers/me', '/caregivers', '/visibility-defaults', '/fasting/state', '/fasting/stats', '/fasting/history?from=2025-01-01&to=2025-12-31',
    '/fasting/settings', `/medications/${med.id}/schedules`, `/medications/${med.id}/logs?from=2026-09-01&to=2026-09-01T23:59`, `/labs/${report.id}`,
    `/export/vitals?user_id=${ADMIN}&from=2026-08-01&to=2026-09-30`, '/export/activities', '/export/labs', '/export/meds-logs', '/export/nutrition',
    '/export/cycle?from=2026-01-01', '/export/fasting?from=2025-01-01&to=2025-12-31', '/vitals?from=2027-07-01T00:00&to=2027-07-31T23:59',
  ]) accepted(await call('GET', route), `GET ${route}`);
});

test('own callers: vitals, medications and doses as the page sends them', async () => {
  accepted(await call('POST', '/vitals', { json: { type: 'bp', measured_at: '2026-09-02T08:00', visibility: 'family', value_num: 120, value_num2: 80, value_num3: 60, unit: 'mmHg', user_id: ADMIN } }), 'vital create');
  accepted(await call('PATCH', `/vitals/${vital.id}`, { json: { type: 'weight', measured_at: '2026-09-01T08:00', visibility: 'private', value_num: 81, value_num2: null, value_num3: null, note: null } }), 'vital patch');
  const medBody = { name: 'Paracetamol', dosage_text: undefined, stock_qty: null, refill_threshold: null, visibility: 'private', active: 1, prn: 1, min_interval_hours: 6, prn_dose_qty: 1 };
  accepted(await call('POST', '/medications', { json: { ...medBody, schedules: [{ time_of_day: '20:00', days_mask: 5, dose_qty: 2 }] } }), 'med create');
  accepted(await call('PATCH', `/medications/${med.id}`, { json: { ...medBody, name: 'Ibuprofen', prn: 0, active: 0, min_interval_hours: null, prn_dose_qty: null } }), 'med patch');
  accepted(await call('POST', `/medications/${med.id}/schedules`, { json: { time_of_day: '12:00', days_mask: null } }), 'schedule create');
  accepted(await call('PATCH', `/schedules/${schedule.id}`, { json: { active: false, days_mask: 127, start_date: '', end_date: null } }), 'schedule patch');
  accepted(await call('POST', `/medications/${med.id}/logs`, { json: { status: 'taken', taken_at: '2026-09-01T09:00', dose_qty: 1, stock_deduct: 1 } }), 'as-needed dose');
  accepted(await call('POST', `/medications/${med.id}/logs`, { json: { status: 'skipped', scheduled_at: '2026-09-01T08:00', schedule_id: schedule.id, dose_qty: 1 } }), 'scheduled dose');
  accepted(await call('POST', `/medications/${med.id}/logs`, { json: { status: 'pending', scheduled_at: '2026-09-01T08:00', schedule_id: String(schedule.id) } }), 'schedule_id as digit text (legacy)');
  accepted(await call('POST', `/logs/${doseLog.id}/take`, { json: { stock_deduct: 1 } }), 'take');
  accepted(await call('POST', `/logs/${doseLog.id}/take`, { json: {} }), 'take without deduction');
  accepted(await call('POST', `/logs/${doseLog.id}/undo`, { json: { stock_credit: 1 } }), 'undo with credit');
  accepted(await call('POST', `/logs/${doseLog.id}/skip`, { json: {} }), 'skip');
  accepted(await call('POST', `/logs/${doseLog.id}/skip`), 'skip without a body: it reads none');
  accepted(await call('POST', `/logs/${doseLog.id}/undo`, { json: {} }), 'undo without credit');
  accepted(await call('PATCH', `/logs/${doseLog.id}`, { json: { status: 'taken', taken_at: '2026-09-01T08:05:00' } }), 'correct a dose');
});

test('own callers: labs, activities, prevention and nutrition', async () => {
  accepted(await call('POST', '/labs', { json: { report_date: '2026-09-03', lab_name: undefined, visibility: 'family', user_id: String(ADMIN) } }), 'lab create, user_id as digit text');
  accepted(await call('PATCH', `/labs/${report.id}`, { json: { report_date: '2026-09-01', lab_name: 'Labor', note: 'n', visibility: 'private' } }), 'lab patch');
  accepted(await call('PATCH', `/results/${result.id}`, { json: { unit: null, ref_low: null, analyte: 'HbA1c', value_num: 5.6, ref_high: 6 } }), 'result patch');
  accepted(await call('POST', '/activities', { json: { type: 'swim', performed_at: '2026-09-02T18:00', visibility: 'private', duration_min: 30, distance_km: 1.2 } }), 'activity create');
  accepted(await call('PATCH', `/activities/${activity.id}`, { json: { type: 'run', performed_at: '2026-09-01T07:00', visibility: 'family', calories: 300 } }), 'activity patch');
  accepted(await call('POST', '/prevention/records', { json: { type_id: preventionType.id, given_on: '2026-02-01', visibility: 'private', interval_months: 120, reminder_offset_days: 30 } }), 'record with type id');
  accepted(await call('POST', '/prevention/records', { json: { type_id: String(preventionType.id), given_on: '2026-02-02', visibility: 'private' } }), 'type_id as digit text (legacy)');
  accepted(await call('POST', '/prevention/records', { json: { type_id: null, name: 'Zahnarzt', given_on: '2026-02-03', visibility: 'private' } }), 'record without type');
  accepted(await call('PATCH', `/prevention/records/${record.id}`, { json: { type_id: preventionType.id, given_on: '2026-01-10', visibility: 'private', next_due_on: null } }), 'record patch');
  accepted(await call('PATCH', `/prevention/types/${preventionType.id}`, { json: { name: 'Tetanus', kind: 'vaccination', icon: 'syringe', default_interval_months: null } }), 'type patch');
  const nutrients = { energy_kcal: 350, fat_g: null, saturated_fat_g: null, carbs_g: 60, sugar_g: 0, protein_g: null, salt_g: null, fiber_g: null };
  accepted(await call('POST', '/nutrition/entries', { json: { title: 'Brot', consumed_at: '2026-09-02T12:00', meal_type: null, note: null, visibility: 'all', ...nutrients } }), 'entry with meal_type null');
  accepted(await call('PATCH', `/nutrition/entries/${entry.id}`, { json: { title: 'Muesli', consumed_at: '2026-09-01T07:30', meal_type: 'snack', note: null, visibility: 'private', ...nutrients } }), 'entry patch');
  accepted(await call('PUT', '/nutrition/targets', { json: nutrients }), 'target');
  accepted(await call('PUT', '/nutrition/targets', { json: {} }), '{} clears the target');
});

test('own callers: the cycle tab, its settings and the import', async () => {
  accepted(await call('POST', '/cycle/periods', { json: { start_date: '2026-07-20', end_date: null, visibility: 'private', note: null } }), 'period create');
  accepted(await call('PATCH', `/cycle/periods/${period.id}`, { json: { end_date: '2026-08-24' } }), 'period end');
  const day = {
    log_date: '2026-08-21', flow: '', symptoms: [{ key: 'cramps', intensity: 2 }, { key: 'acne', intensity: null }], basal_temp: null, basal_temp_unit: null,
    cervix_mucus: '', lh_test: '', pregnancy_test: '', feelings: ['good'], intimacy: '', visibility: 'private', note: null,
  };
  accepted(await call('POST', '/cycle/logs', { json: day }), 'day log, nothing pressed');
  accepted(await call('POST', '/cycle/logs', { json: { ...day, flow: 'heavy', basal_temp: 36.6, basal_temp_unit: 'c', cervix_mucus: 'creamy', lh_test: 'negative', intimacy: 'protected' } }), 'day log, all pressed');
  accepted(await call('PUT', '/cycle/settings', {
    json: {
      cycle_length_avg: 28, period_length_avg: null, luteal_length: 14, track_fertility: true, contraception: null, perimenopause_mode: false, show_pms: true,
      default_visibility: 'private', remind_period_days_before: 2, remind_log_daily: false, notify_partner_user_id: null, notify_partner_days_before: null,
      pregnancy_mode: false, pregnancy_due_date: null,
    },
  }), 'cycle settings');
  accepted(await call('PATCH', '/cycle/visibility', { json: { visibility: 'family' } }), 'bulk visibility');
  accepted(await call('POST', '/cycle/import', { json: { csv: 'start_date,end_date\n2026-01-01,2026-01-05\n' } }), 'import');
  accepted(await call('POST', '/cycle/feed/regenerate'), 'feed regenerate without a body');
  accepted(await call('DELETE', '/cycle/feed'), 'feed off');
});

test('own callers: settings pages and the fasting controls', async () => {
  accepted(await call('PUT', `/caregivers/${MEM}`, { json: { caregiver_ids: [PARTNER] } }), 'caregivers');
  accepted(await call('PUT', `/caregivers/${MEM}`, { json: { caregiver_ids: [String(PARTNER)] } }), 'caregivers as digit text (legacy)');
  accepted(await call('PUT', '/visibility-defaults', { json: { defaults: { 'vital:bp': 'family' } } }), 'default of a vital');
  accepted(await call('PUT', '/visibility-defaults', { json: { defaults: { fasting: 'private' } } }), 'default of fasting');
  accepted(await call('PATCH', '/visibility-defaults/apply', { json: { scope: 'meds', visibility: 'private' } }), 'apply');
  accepted(await call('POST', '/prevention/types', { json: { name: 'Zahnarzt', kind: 'checkup', icon: 'smile', default_interval_months: 6 } }), 'type create');
  accepted(await call('PUT', '/fasting/settings', { json: { default_goal_minutes: 960, active_id: null, expected_revision: undefined } }), 'fasting goal');
  accepted(await call('PUT', '/fasting/settings', { json: { remind_goal: true, remind_next_start: false } }), 'fasting reminders');
  accepted(await call('PUT', '/fasting/settings', { json: { clock_mode: 'remaining' } }), 'clock mode');
  const started = await call('POST', '/fasting', { json: { start_tzid: 'Europe/Berlin', goal_minutes: 960, acknowledge_safety: false } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const finished = await call('POST', `/fasting/${started.body.data.id}/finish`, { json: { expected_revision: started.body.data.revision } });
  accepted(finished, 'finish');
  accepted(await call('PATCH', `/fasting/${fast.id}`, { json: { expected_revision: fast.revision, start_at: fast.start_at, end_at: fast.end_at, start_tzid: 'Europe/Berlin', goal_minutes: 720, rating: 5, note: 'gut', visibility: 'family' } }), 'fasting edit');
  const current = db.prepare('SELECT revision FROM health_fasts WHERE id = ?').get(fast.id);
  accepted(await call('DELETE', `/fasting/${fast.id}?expected_revision=${current.revision}`), 'fasting delete with the revision in the query');
});

// ---------------------------------------------------------------------------
// Muell je Feld: 400 mit `fields`.
// ---------------------------------------------------------------------------

test('a path id that is not plain decimal digits is 400 against the schema (the routes read 7abc as 7 and 1e2 as 1, fasting 0x10 as 16)', async () => {
  for (const id of ['0x10', '7abc', '1e2', '1.5', '%205']) {
    for (const [method, route] of [['PATCH', `/vitals/${id}`], ['DELETE', `/medications/${id}`], ['GET', `/labs/${id}`], ['PATCH', `/results/${id}`],
      ['DELETE', `/cycle/logs/${id}`], ['PATCH', `/prevention/records/${id}`], ['DELETE', `/nutrition/entries/${id}`], ['POST', `/logs/${id}/undo`],
      ['PATCH', `/fasting/${id}`], ['PUT', `/caregivers/${id}`]]) {
      const res = await call(method, route, { json: method === 'GET' || method === 'DELETE' ? undefined : {} });
      refused(res, route.includes('caregivers') ? 'path/subjectId' : 'path/id', `${method} ${route}`);
    }
  }
  // 0 and a negative id stay the route's own answer.
  assert.equal((await call('DELETE', '/vitals/0')).status, 400);
  assert.equal((await call('DELETE', '/vitals/0')).body.error, 'Invalid id.');
  assert.equal((await call('DELETE', '/vitals/-1')).status, 404);
});

test('numbers: text, a truth value or a list is 400 (stored as 16, 0, 0 and 1 before)', async () => {
  for (const value of ['0x10', ' ', [], true, '5']) {
    const label = JSON.stringify(value);
    refused(await call('POST', '/vitals', { json: { type: 'weight', measured_at: '2026-09-02T08:00', value_num: value } }), 'body/value_num', `value_num ${label}`);
    refused(await call('PATCH', `/medications/${med.id}`, { json: { stock_qty: value } }), 'body/stock_qty', `stock_qty ${label}`);
    refused(await call('POST', `/medications/${med.id}/logs`, { json: { dose_qty: value } }), 'body/dose_qty', `dose_qty ${label}`);
    refused(await call('POST', `/labs/${report.id}/results`, { json: { analyte: 'X', value_num: value } }), 'body/value_num', `lab value ${label}`);
    refused(await call('POST', '/activities', { json: { type: 'run', performed_at: '2026-09-02T08:00', calories: value } }), 'body/calories', `calories ${label}`);
    refused(await call('POST', '/nutrition/entries', { json: { title: 'X', consumed_at: '2026-09-02T08:00', fat_g: value } }), 'body/fat_g', `fat_g ${label}`);
    refused(await call('PUT', '/cycle/settings', { json: { cycle_length_avg: value } }), 'body/cycle_length_avg', `cycle_length_avg ${label}`);
  }
  // As-needed limits agree with the route on every number.
  refused(await call('PATCH', `/medications/${med.id}`, { json: { min_interval_hours: 0 } }), 'body/min_interval_hours', 'gap 0');
  refused(await call('PATCH', `/medications/${med.id}`, { json: { min_interval_hours: 673 } }), 'body/min_interval_hours', 'gap 673');
  refused(await call('POST', `/logs/${doseLog.id}/undo`, { json: { stock_credit: -1 } }), 'body/stock_credit', 'negative credit');
});

test('switches and lists: text or a value outside the list is 400 (fell back silently before)', async () => {
  refused(await call('POST', '/medications', { json: { name: 'X', active: 'yes' } }), 'body/active', 'active yes (became 1 before)');
  refused(await call('POST', '/medications', { json: { name: 'X', prn: null } }), 'body/prn', 'prn null (became 0 before)');
  refused(await call('POST', `/medications/${med.id}/schedules`, { json: { time_of_day: '08:00', active: 'true' } }), 'body/active', 'schedule active as text');
  refused(await call('PUT', '/cycle/settings', { json: { show_pms: 'yes' } }), 'body/show_pms', 'cycle switch as text');
  refused(await call('POST', '/vitals', { json: { type: 'weight', measured_at: '2026-09-02T08:00', visibility: 'public' } }), 'body/visibility', 'visibility');
  refused(await call('POST', `/medications/${med.id}/logs`, { json: { status: 'done' } }), 'body/status', 'log status');
  refused(await call('POST', `/labs/${report.id}/results`, { json: { analyte: 'X', flag: 'HIGH' } }), 'body/flag', 'lab flag');
  refused(await call('POST', '/cycle/logs', { json: { log_date: '2026-08-22', flow: 'gush' } }), 'body/flow', 'flow');
  refused(await call('POST', '/cycle/logs', { json: { log_date: '2026-08-22', intimacy: 'yes' } }), 'body/intimacy', 'intimacy');
  refused(await call('POST', '/cycle/logs', { json: { log_date: '2026-08-22', symptoms: 5 } }), 'body/symptoms', 'symptoms as number (cleared them before)');
  refused(await call('POST', '/nutrition/entries', { json: { title: 'X', consumed_at: '2026-09-02T08:00', meal_type: 'brunch' } }), 'body/meal_type', 'meal type');
  refused(await call('PATCH', `/nutrition/entries/${entry.id}`, { json: { meal_type: 'brunch' } }), 'body/meal_type', 'meal type on patch');
  refused(await call('POST', '/prevention/types', { json: { name: 'X', kind: 'vaccine' } }), 'body/kind', 'kind');
  refused(await call('PUT', '/visibility-defaults', { json: { defaults: { budget: 'family' } } }), 'body/defaults', 'unknown area');
  refused(await call('PUT', '/visibility-defaults', { json: { defaults: { 'vital:bp': 'all' } } }), 'body/defaults/vital:bp', 'unknown visibility');
  refused(await call('PATCH', '/visibility-defaults/apply', { json: { scope: ['meds'], visibility: 'family' } }), 'body/scope', 'scope as list (read as meds before)');
  refused(await call('PUT', '/fasting/settings', { json: { zone_mode: 'eco' } }), 'body/zone_mode', 'zone mode');
});

test('caregiver_ids: ["abc"] is 400 and care stays (withdrew all care before)', async () => {
  const before = db.prepare('SELECT caregiver_id FROM health_care_grants WHERE subject_id = ?').all(MEM);
  assert.ok(before.length > 0, 'a grant to keep');
  refused(await call('PUT', `/caregivers/${MEM}`, { json: { caregiver_ids: ['abc'] } }), 'body/caregiver_ids/0', 'caregiver ["abc"]');
  assert.deepEqual(db.prepare('SELECT caregiver_id FROM health_care_grants WHERE subject_id = ?').all(MEM), before, 'care stays');
  // Digit text is the legacy form of an id, but "0" and "00" are no id: the
  // route read them as 0 and dropped them silently, like "abc".
  for (const zero of ['0', '00']) {
    refused(await call('PUT', `/caregivers/${MEM}`, { json: { caregiver_ids: [zero] } }), 'body/caregiver_ids/0', `caregiver ["${zero}"]`);
    assert.deepEqual(db.prepare('SELECT caregiver_id FROM health_care_grants WHERE subject_id = ?').all(MEM), before, `care stays after "${zero}"`);
  }
  // Leading zeros before a real id stay the legacy form.
  accepted(await call('PUT', `/caregivers/${MEM}`, { json: { caregiver_ids: [`00${PARTNER}`] } }), 'caregiver with leading zeros');
  assert.deepEqual(db.prepare('SELECT caregiver_id FROM health_care_grants WHERE subject_id = ?').all(MEM), [{ caregiver_id: PARTNER }]);
});

test('type_id: a number or digit text, nothing else (read by parseInt before)', async () => {
  const typeId = preventionType.id;
  refused(await call('POST', '/prevention/records', { json: { type_id: `${typeId}a`, given_on: '2026-02-01' } }), 'body/type_id', 'type_id 1a (read as 1 before)');
  refused(await call('PATCH', `/prevention/records/${record.id}`, { json: { type_id: [typeId] } }), 'body/type_id', 'type_id as list (read as the id before)');
  refused(await call('POST', '/prevention/records', { json: { type_id: true, given_on: '2026-02-01' } }), 'body/type_id', 'type_id true');
});

test('ids, text and shapes', async () => {
  refused(await call('POST', '/vitals', { json: { type: 'weight', measured_at: '2026-09-02T08:00', user_id: '7abc' } }), 'body/user_id', 'user_id 7abc (read as 7 before)');
  refused(await call('PUT', '/cycle/settings', { json: { notify_partner_user_id: true } }), 'body/notify_partner_user_id', 'partner true (read as 1 before)');
  refused(await call('POST', '/vitals', { json: { type: 5, measured_at: '2026-09-02T08:00' } }), 'body/type', 'number as type');
  refused(await call('POST', '/medications', { json: { name: { a: 1 } } }), 'body/name', 'object as name ("[object Object]" before)');
  refused(await call('PATCH', `/labs/${report.id}`, { json: { note: ['x'] } }), 'body/note', 'list as note');
  refused(await call('POST', '/labs', { json: { report_date: '2026-09-04', results: 'x' } }), 'body/results', 'results not a list (dropped before)');
  refused(await call('POST', '/cycle/import', { json: { csv: 5 } }), 'body/csv', 'csv as number');
  refused(await call('POST', '/vitals', { json: { type: 'weight', measured_at: 'yesterday' } }), 'body/measured_at', 'wall clock');
  refused(await call('POST', '/vitals', { json: { type: 'x'.repeat(fields.MAX_TYPE + 1), measured_at: '2026-09-02T08:00' } }), 'body/type', 'type too long');
  refused(await call('POST', '/fasting', { json: { start_tzid: 'UTC', goal_minutes: '120' } }), 'body/goal_minutes', 'goal as text (read as 120 before)');
  refused(await call('PATCH', `/fasting/${fast.id}`, { json: { expected_revision: '1' } }), 'body/expected_revision', 'revision as text');
  refused(await call('POST', `/medications/${med.id}/logs`), 'body', 'dose log without a body');
});

test('PATCH /fasting/{id} with visibility null is 400 (set private silently before)', async () => {
  const row = (await call('POST', '/fasting', { json: { start_at: '2025-03-01T08:00:00Z', end_at: '2025-03-01T10:00:00Z', start_tzid: 'UTC', visibility: 'family' } })).body.data;
  refused(await call('PATCH', `/fasting/${row.id}`, { json: { expected_revision: row.revision, visibility: null } }), 'body/visibility', 'visibility null');
  assert.equal(db.prepare('SELECT visibility FROM health_fasts WHERE id = ?').get(row.id).visibility, 'family');
});

test('query garbage is 400 (ignored or read as "everybody" before)', async () => {
  for (const [route, path] of [
    ['/vitals?user_id=abc', 'query/user_id'], ['/vitals?user_id=0', 'query/user_id'], ['/labs?user_id=1&user_id=2', 'query/user_id'],
    ['/medications?active=maybe', 'query/active'], ['/prevention/records?type_id=x', 'query/type_id'], ['/export/vitals?from=x', 'query/from'],
    ['/export/cycle?to=2026-02-30', 'query/to'], ['/nutrition/entries?meal_type=brunch', 'query/meal_type'], ['/nutrition/targets?user_id=abc', 'query/user_id'],
    ['/fasting/history?limit=abc', 'query/limit'], ['/cycle/logs?from=a&from=b', 'query/from'], ['/prevention/due?user_id=abc', 'query/user_id'],
  ]) refused(await call('GET', route), path, route);
});

// ---------------------------------------------------------------------------
// Reihenfolge
// ---------------------------------------------------------------------------

test('order: a broken body at an unknown id is 400, not 404; a valid one meets the 404', async () => {
  for (const [route, json] of /** @type {Array<[string, unknown]>} */ ([['/vitals/999999', { value_num: 'x' }], ['/medications/999999', { active: 'x' }], ['/labs/999999', { report_date: 5 }],
    ['/activities/999999', { calories: 'x' }], ['/cycle/periods/999999', { start_date: 'x' }], ['/prevention/records/999999', { dose_number: 'x' }],
    ['/nutrition/entries/999999', { fat_g: 'x' }], ['/schedules/999999', { days_mask: 'x' }], ['/results/999999', { flag: 'x' }], ['/logs/999999', { status: 'x' }]])) {
    assert.equal((await call('PATCH', route, { json })).status, 400, `broken ${route}`);
    assert.equal((await call('PATCH', route, { json: {} })).status, 404, `valid ${route}`);
  }
  // 409 of the dose log: a scheduled entry cannot be deleted - behind a valid id only.
  assert.equal((await call('DELETE', `/logs/${doseLog.id}`)).status, 409);
});

test('rights without a row stand in front: fasting capability 403 before 400', async () => {
  for (const [method, route, json] of /** @type {Array<[string, string, unknown?]>} */ ([
    ['GET', '/fasting/state?user_id=abc'], ['GET', '/fasting/history?limit=abc'], ['GET', '/fasting?from=x'], ['GET', '/fasting/stats?user_id=x'],
    ['GET', '/fasting/settings?user_id=x'], ['GET', '/export/fasting?from=x'], ['POST', '/fasting', { goal_minutes: 'x' }],
    ['POST', '/fasting/acknowledge-safety', { user_id: true }], ['POST', '/fasting/0x10/finish', { expected_revision: 'x' }],
    ['PATCH', '/fasting/0x10', { visibility: null }], ['DELETE', '/fasting/0x10?expected_revision=x'], ['PUT', '/fasting/settings', { zone_mode: 'x' }],
    ['PUT', '/visibility-defaults', { defaults: { fasting: 'all' } }], ['PATCH', '/visibility-defaults/apply', { scope: 'fasting', visibility: 'all' }],
  ])) {
    const res = await call(method, route, { json, actor: 'nofast' });
    assert.equal(res.status, 403, `${method} ${route}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'FASTING_CAPABILITY_REQUIRED', `${method} ${route}`);
  }
  // Another area of the defaults stays open for the same account; its garbage is the schema's.
  accepted(await call('PUT', '/visibility-defaults', { json: { defaults: { meds: 'family' } }, actor: 'nofast' }), 'meds default without fasting');
  refused(await call('PUT', '/visibility-defaults', { json: { defaults: { meds: 'all' } }, actor: 'nofast' }), 'body/defaults/meds', 'meds garbage');
  // With the capability the garbage is the schema's 400.
  refused(await call('POST', '/fasting', { json: { goal_minutes: 'x', start_tzid: 'UTC' }, actor: 'mem' }), 'body/goal_minutes', 'member with capability');
});

test('rights without a row stand in front: requireAdmin 403 before 400', async () => {
  for (const [method, route, json] of /** @type {Array<[string, string, unknown?]>} */ ([
    ['PUT', `/caregivers/${MEM}`, { caregiver_ids: ['abc'] }], ['PUT', '/caregivers/0x10', {}], ['GET', '/caregivers'],
    ['POST', '/prevention/types', { kind: 'x' }], ['PATCH', '/prevention/types/0x10', { kind: 'x' }], ['DELETE', '/prevention/types/0x10'],
  ])) {
    const res = await call(method, route, { json, actor: 'mem' });
    assert.equal(res.status, 403, `${method} ${route}: ${JSON.stringify(res.body)}`);
  }
});

// ---------------------------------------------------------------------------
// Senke und eine Quelle
// ---------------------------------------------------------------------------

test('the sink: validateBasalTemp() looks up own keys only (constructor stored 99999 before)', () => {
  for (const unit of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = validateBasalTemp(99999, unit);
    assert.ok(r.error, `${unit} is refused by the handler itself`);
    assert.equal(r.temp, null);
  }
  assert.deepEqual(validateBasalTemp(36.6, 'C'), { temp: 36.6, unit: 'c', error: null });
  assert.ok(validateBasalTemp(99999, 'c').error);
  // In front of it the schema refuses the same.
  return call('POST', '/cycle/logs', { json: { log_date: '2026-08-23', basal_temp: 99999, basal_temp_unit: 'constructor' } })
    .then((res) => refused(res, 'body/basal_temp_unit', 'basal unit constructor'));
});

test('one source: every list of the schemas is the constant the handler reads', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const bodyOf = (/** @type {string} */ path, /** @type {string} */ method) => spec.paths[path][method].requestBody.content['application/json'].schema;
  const strip = (/** @type {unknown[]} */ list) => list.filter((v) => v !== null && v !== '');
  const vitals = bodyOf('/api/v1/health/vitals', 'post').properties;
  assert.deepEqual(strip(vitals.visibility.enum), [...fields.VISIBILITIES]);
  assert.equal(vitals.type.maxLength, fields.MAX_TYPE);
  assert.equal(vitals.unit.maxLength, fields.MAX_UNIT);
  assert.deepEqual(strip(bodyOf('/api/v1/health/medications/{id}/logs', 'post').properties.status.enum), [...fields.LOG_STATUS]);
  const meds = bodyOf('/api/v1/health/medications', 'post').properties;
  assert.equal(meds.min_interval_hours.maximum, fields.MAX_INTERVAL_HOURS);
  assert.equal(meds.schedules.maxItems, fields.MAX_SCHEDULES_ON_CREATE);
  assert.deepEqual(strip(bodyOf('/api/v1/health/labs/{id}/results', 'post').properties.flag.enum), [...fields.LAB_FLAGS]);
  const day = bodyOf('/api/v1/health/cycle/logs', 'post').properties;
  assert.deepEqual(strip(day.flow.enum), [...cycleLists.FLOW_VALUES]);
  assert.deepEqual(strip(day.basal_temp_unit.enum), [...cycleLists.BASAL_TEMP_UNITS]);
  assert.deepEqual(strip(day.cervix_mucus.enum), [...cycleLists.CERVIX_MUCUS_VALUES]);
  assert.deepEqual(strip(day.lh_test.enum), [...cycleLists.TEST_RESULT_VALUES]);
  assert.deepEqual(strip(day.intimacy.enum), [...cycleLists.INTIMACY_VALUES]);
  assert.deepEqual(day.feelings.items.enum, [...cycleLists.MOOD_VALUES]);
  const settings = bodyOf('/api/v1/health/cycle/settings', 'put').properties;
  assert.deepEqual(strip(settings.contraception.enum), [...cycleLists.CONTRACEPTION_VALUES]);
  for (const [field, [min, max]] of Object.entries(fields.CYCLE_SETTING_RANGES)) {
    assert.deepEqual([settings[field].minimum, settings[field].maximum], [min, max], field);
  }
  const types = bodyOf('/api/v1/health/prevention/types', 'post').properties;
  assert.deepEqual(types.kind.enum, [...fields.PREVENTION_KINDS]);
  assert.equal(types.default_interval_months.maximum, fields.MAX_INTERVAL_MONTHS);
  assert.equal(bodyOf('/api/v1/health/prevention/records', 'post').properties.reminder_offset_days.maximum, fields.MAX_OFFSET_DAYS);
  const nutrition = bodyOf('/api/v1/health/nutrition/entries', 'post').properties;
  assert.deepEqual(strip(nutrition.meal_type.enum), [...fields.MEAL_TYPES]);
  assert.deepEqual(strip(nutrition.visibility.enum), [...fields.NUTRITION_VISIBILITIES]);
  for (const key of fields.NUTRIENT_KEYS) assert.equal(nutrition[key].maximum, fields.MAX_NUTRIENT, key);
  assert.equal(bodyOf('/api/v1/health/visibility-defaults', 'put').properties.defaults.propertyNames.pattern, fields.SCOPE_KEY_PATTERN);
});
