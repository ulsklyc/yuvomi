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

test('fasting stats are exposed as scoped summaries and streaks', async () => {
  const ownerId = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('stats-summary-owner', 'Stats summary owner', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(ownerId));
  viewer = ownerId;
  const created = await call('POST', '/fasting', {
    start_at: '2025-01-01T06:00:00.000Z', end_at: '2025-01-01T08:00:00.000Z',
    start_tzid: 'UTC', goal_minutes: 60, acknowledge_safety: true,
  });
  assert.equal(created.status, 201);
  const response = await call('GET', '/fasting/stats');
  assert.equal(response.status, 200);
  assert.ok(response.body.data.allTime.count >= 1);
  assert.equal(response.body.data.allTime.count, 1);
  assert.equal(typeof response.body.data.currentStreak, 'number');
  assert.equal(response.body.data.weekly.length, 7);
});


test('fasting stats count all 16 independently seeded records', async () => {
  const ownerId = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('stats-sixteen-owner', 'Stats sixteen owner', 'x', 'member')").run().lastInsertRowid;
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
  const response = await call('GET', '/fasting/stats');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.allTime.count, 16);
});


test('stats handle a very long backfilled fast through the authorized API', async () => {
  const id = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('long-fast', 'Long fast', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));
  viewer = id;
  const created = await call('POST', '/fasting', { start_at: '-200000-01-01T00:00:00Z', end_at: '2026-09-01T00:00:00Z', start_tzid: 'UTC', goal_minutes: 60, acknowledge_safety: true });
  assert.equal(created.status, 201);
  const stats = await call('GET', '/fasting/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.longestStreak, 73788725);
  assert.equal(stats.body.data.allTime.count, 1);
});


test('stats use household display-zone calendar windows and count sub-minute records', async () => {
  const id = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('stats-zone', 'Stats zone', 'x', 'member')").run().lastInsertRowid;
  database.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')").run(String(id));
  const previousZone = database.prepare("SELECT value FROM sync_config WHERE key = 'household_timezone'").get();
  try {
    database.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Prague') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    database.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes)
      VALUES (?, '2025-12-31T22:59:30.000Z', '2025-12-31T23:00:00.000Z', 'Europe/Prague', NULL),
             (?, '2025-12-02T22:00:00.000Z', '2025-12-03T00:00:00.000Z', 'Europe/Prague', 60)`).run(id, id);
    const { getFastingStats } = await import('../server/services/fasting.js');
    const stats = getFastingStats(database, { id }, id, new Date('2025-12-31T23:30:00.000Z'));
    assert.equal(stats.display_tzid, 'Europe/Prague');
    assert.equal(stats.today, '2026-01-01');
    assert.equal(stats.year.count, 1);
    assert.equal(stats.year.totalMinutes, 0);
    assert.equal(stats.last30Days.count, 2);
  } finally {
    if (previousZone) database.prepare("UPDATE sync_config SET value = ? WHERE key = 'household_timezone'").run(previousZone.value);
    else database.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
});
