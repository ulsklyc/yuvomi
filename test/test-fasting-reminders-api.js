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

test('fasting reminder switches are owner-configurable and survive partial updates', async () => {
  const ownerId = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('reminder-switch-owner', 'Reminder switch owner', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(ownerId));
  viewer = ownerId;
  let response = await call('PUT', '/fasting/settings', { remind_goal: true, remind_next_start: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.remind_goal, 1);
  assert.equal(response.body.data.remind_next_start, 1);
  response = await call('PUT', '/fasting/settings', { remind_goal: false });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.remind_goal, 0);
  assert.equal(response.body.data.remind_next_start, 1);
});


test('HTTP lifecycle reconciles exact owner reminders immediately after every mutation', async () => {
  const id = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('immediate-reminders', 'Immediate reminders', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));
  database.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('fasting_goal', 999999, '2099-01-01T00:00:00.000Z', ?)").run(userA);
  viewer = id;
  assert.equal((await call('PUT', '/fasting/settings', { default_goal_minutes: 60, remind_goal: true, remind_next_start: true, acknowledge_safety: true })).status, 200);
  const anchor = Date.now();
  const start = new Date(anchor - 10 * 60_000).toISOString();
  const movedStart = new Date(anchor - 15 * 60_000).toISOString();
  const end = new Date(anchor - 60_000).toISOString();
  const movedEnd = new Date(anchor - 30_000).toISOString();
  let response = await call('POST', '/fasting', { start_at: start, start_tzid: 'UTC', goal_minutes: 60 });
  assert.equal(response.status, 201);
  const fastId = response.body.data.id;
  const owned = () => database.prepare("SELECT entity_type, entity_id, remind_at, created_by FROM reminders WHERE created_by = ? AND entity_type LIKE 'fasting_%' ORDER BY entity_type").all(id);
  const goalTuple = (at, minutes) => [{ entity_type: 'fasting_goal', entity_id: fastId, remind_at: new Date(Date.parse(at) + minutes * 60_000).toISOString(), created_by: id }];
  const nextTuple = (at, minutes) => [{ entity_type: 'fasting_next_start', entity_id: fastId, remind_at: new Date(Date.parse(at) + (24 * 60 - minutes) * 60_000).toISOString(), created_by: id }];
  assert.deepEqual(owned(), goalTuple(start, 60));

  response = await call('PATCH', `/fasting/${fastId}`, { expected_revision: 1, start_at: movedStart });
  assert.equal(response.status, 200);
  assert.deepEqual(owned(), goalTuple(movedStart, 60));
  response = await call('PATCH', `/fasting/${fastId}`, { expected_revision: 2, goal_minutes: 120 });
  assert.equal(response.status, 200);
  assert.deepEqual(owned(), goalTuple(movedStart, 120));
  response = await call('POST', `/fasting/${fastId}/finish`, { expected_revision: 3, end_at: end });
  assert.equal(response.status, 200);
  assert.deepEqual(owned(), nextTuple(end, 120));
  response = await call('PATCH', `/fasting/${fastId}`, { expected_revision: 4, end_at: movedEnd });
  assert.equal(response.status, 200);
  assert.deepEqual(owned(), nextTuple(movedEnd, 120));
  response = await call('PATCH', `/fasting/${fastId}`, { expected_revision: 5, end_at: null });
  assert.equal(response.status, 200);
  assert.deepEqual(owned(), goalTuple(movedStart, 120));
  response = await call('PUT', '/fasting/settings', { default_goal_minutes: 180, active_id: fastId, expected_revision: 6 });
  assert.equal(response.status, 200);
  assert.deepEqual(owned(), goalTuple(movedStart, 180));
  response = await call('POST', `/fasting/${fastId}/finish`, { expected_revision: 7, end_at: movedEnd });
  assert.equal(response.status, 200);
  assert.deepEqual(owned(), nextTuple(movedEnd, 180));
  response = await call('DELETE', `/fasting/${fastId}`, { expected_revision: 8 });
  assert.equal(response.status, 204);
  assert.deepEqual(owned(), []);
  assert.equal(database.prepare("SELECT count(*) AS count FROM reminders WHERE created_by = ? AND entity_type = 'fasting_goal' AND entity_id = 999999").get(userA).count, 1);
});


test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
});
