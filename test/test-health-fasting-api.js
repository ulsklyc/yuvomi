import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: healthRouter } = await import('../server/routes/health.js');

const database = new Database(':memory:');
database.pragma('foreign_keys = ON');
for (const migration of MIGRATIONS) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
}
_setTestDatabase(database);
const userA = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('fa', 'Fasting A', 'x', 'member')").run().lastInsertRowid;
const userB = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('fb', 'Fasting B', 'x', 'member')").run().lastInsertRowid;
for (const id of [userA, userB]) database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));

let viewer = userA;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = viewer; req.session = { userId: viewer }; next(); });
app.use('/api/v1/health', healthRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/health`;
async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('fasting API returns numeric code and symbolic reason, then supports lifecycle', async () => {
  viewer = userA;
  let response = await call('POST', '/fasting', { start_at: '2026-09-13T08:00:00+02:00', start_tzid: 'Europe/Prague', goal_minutes: 960, acknowledge_safety: true });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.start_at, '2026-09-13T06:00:00.000Z');
  const id = response.body.data.id;
  response = await call('POST', '/fasting', { start_at: '2026-09-13T09:00:00+02:00', start_tzid: 'Europe/Prague', acknowledge_safety: false });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 409);
  assert.equal(response.body.reason, 'FASTING_ACTIVE_EXISTS');
  response = await call('POST', '/fasting/acknowledge-safety', {});
  assert.equal(response.status, 200);
  response = await call('POST', `/fasting/${id}/finish`, { expected_revision: 1, end_at: '2026-09-13T12:00:00+02:00' });
  assert.equal(response.status, 200);
  response = await call('PATCH', `/fasting/${id}`, { expected_revision: 2, note: 'edited' });
  assert.equal(response.body.data.note, 'edited');
  response = await call('DELETE', `/fasting/${id}`, { expected_revision: 3 });
  assert.equal(response.status, 204);
});

test('fasting API enforces private visibility and caregiver grant', async () => {
  viewer = userA;
  const created = await call('POST', '/fasting', { start_at: '2026-09-13T09:00:00+02:00', end_at: '2026-09-13T12:00:00+02:00', start_tzid: 'Europe/Prague', acknowledge_safety: false });
  assert.equal(created.status, 201);
  viewer = userB;
  let response = await call('GET', '/fasting/history?user_id=' + userA);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 0);
  response = await call('PATCH', `/fasting/${created.body.data.id}`, { expected_revision: 1, note: 'nope' });
  assert.equal(response.status, 403);
  database.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(userA, userB);
  response = await call('GET', '/fasting/history?user_id=' + userA);
  assert.equal(response.body.data.length, 1);
  response = await call('PATCH', `/fasting/${created.body.data.id}`, { expected_revision: 1, note: 'care' });
  assert.equal(response.status, 200);
});

test('visibility defaults accepts fasting scope and CSV is escaped', async () => {
  viewer = userA;
  let response = await call('PUT', '/visibility-defaults', { defaults: { fasting: 'family' } });
  assert.equal(response.status, 200);
  response = await call('GET', '/visibility-defaults');
  assert.equal(response.body.data.defaults.fasting, 'family');
  const created = await call('POST', '/fasting', { start_at: '2026-09-12T08:00:00+02:00', end_at: '2026-09-12T12:00:00+02:00', start_tzid: 'Europe/Prague', note: '=formula', acknowledge_safety: false });
  assert.equal(created.status, 201);
  response = await fetch(`${base}/export/fasting`);
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.match(csv, /start_at/);
  assert.match(csv, /'=formula/);
});

test('bulk fasting visibility advances owner revision and audit, rejecting stale privacy edits', async () => {
  const createOwner = (name) => {
    const id = database.prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)').run(name, name, 'x', 'member').lastInsertRowid;
    database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));
    return id;
  };
  // Keep this mutation's owners separate from the lifecycle/pagination fixtures.
  const userA = createOwner('bulk-privacy-owner'), userB = createOwner('bulk-privacy-other');
  viewer = userA;
  const payload = { start_at: '2025-02-01T08:00Z', end_at: '2025-02-01T09:00Z', start_tzid: 'UTC', visibility: 'family', acknowledge_safety: true };
  const own = (await call('POST', '/fasting', payload)).body.data;
  viewer = userB;
  const other = (await call('POST', '/fasting', payload)).body.data;
  database.prepare("UPDATE health_fasts SET updated_at = '2025-01-01T00:00:00.000Z', updated_by = ? WHERE id = ?").run(userB, own.id);
  viewer = userA;
  const applied = await call('PATCH', '/visibility-defaults/apply', { scope: 'fasting', visibility: 'private', user_id: userB });
  assert.equal(applied.status, 200);
  const saved = database.prepare('SELECT * FROM health_fasts WHERE id = ?').get(own.id);
  assert.equal(saved.visibility, 'private');
  assert.equal(saved.revision, own.revision + 1);
  assert.equal(saved.updated_by, userA);
  assert.ok(Date.parse(saved.updated_at) > Date.parse('2025-01-01T00:00:00Z'));
  assert.equal(database.prepare('SELECT visibility FROM health_fasts WHERE id = ?').get(other.id).visibility, 'family');
  assert.equal(database.prepare('SELECT revision FROM health_fasts WHERE id = ?').get(other.id).revision, other.revision);
  const stale = await call('PATCH', `/fasting/${own.id}`, { expected_revision: own.revision, visibility: 'family', note: 'stale editor' });
  assert.equal(stale.status, 409);
  assert.equal(database.prepare('SELECT visibility FROM health_fasts WHERE id = ?').get(own.id).visibility, 'private');
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
});

test('goal changes update only the current fast atomically and preferences are owner-scoped', async () => {
  viewer = userA;
  const created = await call('POST', '/fasting', { start_at: '2026-09-13T13:00:00Z', start_tzid: 'UTC' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  let response = await call('PUT', '/fasting/settings', { default_goal_minutes: 4320, active_id: id, expected_revision: 1, clock_mode: 'remaining' });
  assert.equal(response.status, 200);
  const state = (await call('GET', '/fasting/state')).body.data;
  assert.equal(state.active.goal_minutes, 4320);
  assert.equal(state.active.revision, 2);
  assert.equal(state.settings.clock_mode, 'remaining');
  assert.equal(state.history.find((row) => row.note === 'care').goal_minutes, null);
  response = await call('PUT', '/fasting/settings', { default_goal_minutes: 720, active_id: id, expected_revision: 1 });
  assert.equal(response.status, 409);
  assert.equal((await call('GET', '/fasting/state')).body.data.settings.default_goal_minutes, 4320);
  response = await call('PUT', '/fasting/settings', { clock_mode: 'invalid' });
  assert.equal(response.status, 400);
  viewer = userB;
  assert.equal((await call('GET', '/fasting/state')).body.data.settings.clock_mode, 'auto');
  assert.equal((await call('PUT', '/fasting/settings?user_id=' + userA, { clock_mode: 'elapsed' })).status, 403);
});

test('history is bounded with stable cursor pages while export stays complete', async () => {
  const ownerId = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('journal-sixteen-owner', 'Journal sixteen owner', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(ownerId));
  viewer = ownerId;
  for (let day = 1; day <= 16; day++) {
    const date = `2025-01-${String(day).padStart(2, '0')}`;
    const created = await call('POST', '/fasting', {
      start_at: `${date}T06:00:00.000Z`, end_at: `${date}T07:00:00.000Z`,
      start_tzid: 'UTC', acknowledge_safety: day === 1,
    });
    assert.equal(created.status, 201);
  }
  const first = (await call('GET', '/fasting/state')).body.data;
  assert.equal(first.history.length, 10);
  assert.equal(first.history_has_more, true);
  const cursor = first.history_next_cursor;
  const next = await call('GET', `/fasting/history?before_at=${encodeURIComponent(cursor.before_at)}&before_id=${cursor.before_id}`);
  assert.equal(next.body.data.length, 6);
  assert.equal(next.body.has_more, false);
  assert.equal(new Set([...first.history, ...next.body.data].map((row) => row.id)).size, 16);
  assert.equal((await (await fetch(`${base}/export/fasting`)).text()).trim().split('\n').length, 17);
  assert.equal((await call('GET', '/fasting/history?limit=10000')).status, 400);
  assert.equal((await call('GET', '/fasting/history?before_id=1')).status, 400);
});

test('family readers see shared records but not private fasting preferences or acknowledgement', async () => {
  database.prepare('DELETE FROM health_care_grants WHERE subject_id = ? AND caregiver_id = ?').run(userA, userB);
  viewer = userB;
  const state = await call('GET', '/fasting/state?user_id=' + userA);
  assert.equal(state.status, 200);
  assert.ok(state.body.data.history.length > 0, 'family-visible history remains readable');
  assert.ok(state.body.data.history.every((row) => row.visibility === 'family'));
  assert.equal(state.body.data.settings, null);
  assert.equal(state.body.data.acknowledged, null);
  assert.equal(state.body.data.canWrite, false);
  assert.equal((await call('GET', '/fasting/settings?user_id=' + userA)).body.data, null);
  assert.equal((await call('POST', '/fasting/acknowledge-safety', { user_id: userA })).status, 403);

  database.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(userA, userB);
  const managed = (await call('GET', '/fasting/state?user_id=' + userA)).body.data;
  assert.equal(managed.canWrite, true);
  assert.equal(managed.settings.default_goal_minutes, 4320);
  assert.equal(managed.acknowledged, true);
  assert.equal((await call('GET', '/fasting/settings?user_id=' + userA)).body.data.clock_mode, 'remaining');
  viewer = userA;
  assert.equal((await call('GET', '/fasting/state')).body.data.settings.default_goal_minutes, 4320);
  database.prepare('DELETE FROM health_care_grants WHERE subject_id = ? AND caregiver_id = ?').run(userA, userB);
  viewer = userB;
  assert.equal((await call('GET', '/fasting/state?user_id=' + userA)).body.data.settings, null, 'revocation takes effect immediately');
  viewer = userA;
  assert.equal((await call('GET', '/fasting/state?user_id=' + userB)).body.data.settings, null, 'sparse settings do not expose a second read path');
});

test('history and export filter inclusive recorded-zone completion dates', async () => {
  const id = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('dates', 'Dates', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));
  viewer = id;
  for (const [start, end, zone, goal] of [
    ['2026-09-12T06:00:00Z', '2026-09-12T22:30:00Z', 'Europe/Prague', 960],
    ['2026-09-12T23:30:00Z', '2026-09-13T06:30:00Z', 'America/Los_Angeles', null],
  ]) {
    assert.equal((await call('POST', '/fasting', { start_at: start, end_at: end, start_tzid: zone, goal_minutes: goal, acknowledge_safety: true })).status, 201);
  }
  const local14 = await call('GET', '/fasting/history?from=2026-09-13&to=2026-09-13');
  assert.equal(local14.status, 200);
  assert.deepEqual(local14.body.data.map((row) => row.start_tzid), ['Europe/Prague']);
  const local13 = await call('GET', '/fasting/history?from=2026-09-12&to=2026-09-12');
  assert.deepEqual(local13.body.data.map((row) => row.start_tzid), ['America/Los_Angeles']);
  for (const query of ['from=2026-02-30', 'to=2026-09', 'from=2026-09-14&to=2026-09-13']) {
    const response = await call('GET', `/fasting/history?${query}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.reason, 'FASTING_DATE_RANGE_INVALID');
  }
  const csvResponse = await fetch(`${base}/export/fasting?from=2026-09-13&to=2026-09-13`);
  const csv = await csvResponse.text();
  assert.equal(csv.trim().split('\n').length, 2);
  assert.equal(csv.replace(/^\ufeff/, '').split('\n')[0], '"start_at","end_at","start_tzid","duration_minutes","goal_minutes","goal_reached","rating","note","visibility"');
  assert.match(csv, /,"960","true",/);
});

test('filtered history preserves cursor has-more and family visibility', async () => {
  const id = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('pages', 'Pages', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));
  const insert = database.prepare(`INSERT INTO health_fasts
    (user_id, start_at, end_at, start_tzid, goal_minutes, visibility, created_by, updated_by)
    VALUES (?, ?, ?, 'UTC', 60, ?, ?, ?)`);
  insert.run(id, '2026-09-13T08:00:00.000Z', '2026-09-13T09:00:00.000Z', 'family', id, id);
  insert.run(id, '2026-09-12T08:00:00.000Z', '2026-09-13T07:00:00.000Z', 'private', id, id);
  insert.run(id, '2026-09-11T08:00:00.000Z', '2026-09-13T06:00:00.000Z', 'family', id, id);
  insert.run(id, '2026-09-10T08:00:00.000Z', '2026-09-10T09:00:00.000Z', 'family', id, id);
  viewer = id;
  const first = await call('GET', '/fasting/history?from=2026-09-13&to=2026-09-13&limit=1');
  assert.equal(first.body.has_more, true);
  assert.equal(first.body.data.length, 1);
  const cursor = first.body.next_cursor;
  const second = await call('GET', `/fasting/history?from=2026-09-13&to=2026-09-13&limit=1&before_at=${encodeURIComponent(cursor.before_at)}&before_id=${cursor.before_id}`);
  assert.equal(second.body.has_more, true);
  assert.equal(second.body.data.length, 1);
  const thirdCursor = second.body.next_cursor;
  const third = await call('GET', `/fasting/history?from=2026-09-13&to=2026-09-13&limit=1&before_at=${encodeURIComponent(thirdCursor.before_at)}&before_id=${thirdCursor.before_id}`);
  assert.equal(third.body.has_more, false);
  assert.equal(third.body.data.length, 1);
  viewer = userB;
  const family = await call('GET', `/fasting/history?user_id=${id}&from=2026-09-13&to=2026-09-13`);
  assert.deepEqual(family.body.data.map((row) => row.visibility), ['family', 'family']);
});

test('fasting CSV distinguishes missed, null-goal and positive sub-minute records', async () => {
  const id = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('csv-cases', 'CSV cases', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));
  const insert = database.prepare(`INSERT INTO health_fasts
    (user_id, start_at, end_at, start_tzid, goal_minutes, visibility, created_by, updated_by)
    VALUES (?, ?, ?, 'UTC', ?, 'private', ?, ?)`);
  insert.run(id, '2026-09-01T00:00:00.000Z', '2026-09-01T00:30:00.000Z', 60, id, id);
  insert.run(id, '2026-09-02T00:00:00.000Z', '2026-09-02T00:30:00.000Z', null, id, id);
  insert.run(id, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:30.000Z', 60, id, id);
  viewer = id;
  const response = await fetch(`${base}/export/fasting`);
  const lines = (await response.text()).replace(/^\ufeff/, '').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines.some((line) => line.includes('"30","60","false"')));
  assert.ok(lines.some((line) => line.includes('"30","",""')));
  assert.ok(lines.some((line) => line.includes('"0","60","false"')));
});

test('granted caregiver can acknowledge through sparse settings input only', async () => {
  const subjectId = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('ack-subject', 'Ack subject', 'x', 'member')").run().lastInsertRowid;
  const caregiverId = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('ack-caregiver', 'Ack caregiver', 'x', 'member')").run().lastInsertRowid;
  for (const id of [subjectId, caregiverId]) database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));
  database.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(subjectId, caregiverId);
  viewer = caregiverId;
  let response = await call('PUT', `/fasting/settings?user_id=${subjectId}`, { acknowledge_safety: true });
  assert.equal(response.status, 200);
  assert.ok(response.body.data.safety_acknowledged_at);
  response = await call('PUT', `/fasting/settings?user_id=${subjectId}`, { zone_mode: 'educational' });
  assert.equal(response.status, 403);
  database.prepare('DELETE FROM health_care_grants WHERE subject_id = ? AND caregiver_id = ?').run(subjectId, caregiverId);
  response = await call('PUT', `/fasting/settings?user_id=${subjectId}`, { acknowledge_safety: true });
  assert.equal(response.status, 403);
});

test('journal state exposes the household display zone', async () => {
  const id = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('journal-display-zone', 'Journal display zone', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));
  const previousZone = database.prepare("SELECT value FROM sync_config WHERE key = 'household_timezone'").get();
  try {
    database.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Prague') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    const { getFastingState } = await import('../server/services/fasting.js');
    assert.equal(getFastingState(database, { id }, id).display_tzid, 'Europe/Prague');
  } finally {
    if (previousZone) database.prepare("UPDATE sync_config SET value = ? WHERE key = 'household_timezone'").run(previousZone.value);
    else database.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
});
