import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
import { WIDGET_IDS, DEFAULT_HIDDEN_WIDGETS, defaultWidgetSize } from '../public/utils/dashboard-widgets.js';
import { PERMISSION_WIDGETS } from '../server/permissions.js';

test('fasting dashboard widget is registered and sized as a compact timer', () => {
  assert.ok(WIDGET_IDS.includes('fasting'));
  assert.ok(DEFAULT_HIDDEN_WIDGETS.has('fasting'), 'existing dashboards must opt in to the new widget');
  assert.equal(defaultWidgetSize('fasting'), '2x1');
  assert.deepEqual(PERMISSION_WIDGETS.find((item) => item.id === 'fasting'), { id: 'fasting', module: 'health' });
});

test('dashboard owns the shared fasting control styles', () => {
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /^@import url\('\/styles\/fasting-controls\.css'\);/);
  assert.match(css, /\.widget--fasting\s*\{\s*--widget-accent:\s*var\(--module-health\);\s*\}/);
});

test('dashboard obtains fasting state from the fasting service', () => {
  const source = readFileSync(new URL('../server/routes/dashboard.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ FastingError, getFastingState \} from '\.\.\/services\/fasting\.js';/);
  assert.match(source, /getFastingState\(d, permissionUser\)/);
  assert.doesNotMatch(source, /SELECT \* FROM health_fasts/);

  const widgetRenderer = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8')
    .split('function renderFastingWidget')[1]
    .split('function wireFastingWidget')[0];
  assert.match(widgetRenderer, /if \(!fasting\) throw new Error\(/,
    'a failed fasting slice must reach the shared retryable widget error');
});

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-fasting-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const moduleDatabase = get();
const database = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(database);
moduleDatabase.close();

function seedUser(prefix) {
  return database.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', 'member', 'parent')
  `).run(`${prefix}-${randomUUID()}`, prefix).lastInsertRowid;
}

function setPermission(userId, resourceType, resourceKey, access) {
  database.prepare(`
    INSERT OR REPLACE INTO access_permissions
      (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, ?, ?, ?)
  `).run(String(userId), resourceType, resourceKey, access);
}

const OWNER = seedUser('fasting-dashboard-owner');
const OTHER = seedUser('fasting-dashboard-other');
setPermission(OWNER, 'capability', 'health_use_fasting', 'allow');
setPermission(OTHER, 'capability', 'health_use_fasting', 'allow');

const ownerCompleted = database.prepare(`
  INSERT INTO health_fasts
    (user_id, start_at, end_at, start_tzid, goal_minutes, visibility, created_by, updated_by)
  VALUES (?, '2026-09-15T16:00:00.000Z', '2026-09-16T08:00:00.000Z', 'UTC', 960, 'private', ?, ?)
`).run(OWNER, OWNER, OWNER).lastInsertRowid;
database.prepare(`
  INSERT INTO health_fasts
    (user_id, start_at, end_at, start_tzid, goal_minutes, visibility, created_by, updated_by)
  VALUES (?, '2026-09-17T18:00:00.000Z', NULL, 'UTC', 960, 'family', ?, ?)
`).run(OTHER, OTHER, OTHER);
database.prepare(`
  INSERT INTO health_fasting_settings
    (user_id, default_goal_minutes, zone_mode, safety_acknowledged_at, safety_acknowledged_by)
  VALUES (?, 960, 'timer', '2026-09-01T00:00:00.000Z', ?)
`).run(OWNER, OWNER);
database.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, 'remaining')")
  .run(`fasting_clock_mode:user:${OWNER}`);
database.prepare(`
  INSERT INTO medications (user_id, name, active, visibility)
  VALUES (?, 'Owner medication', 1, 'private')
`).run(OWNER);

let actor = OWNER;
let tokenScopes = null;
const app = express();
app.use((req, _res, next) => {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actor);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(database, user));
  req.authScopes = tokenScopes;
  next();
});
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  database.close();
});

async function dashboard() {
  const response = await fetch(endpoint);
  assert.equal(response.status, 200);
  return response.json();
}

test('dashboard fasting payload is self-only even when another fast is family-visible and active', async () => {
  const body = await dashboard();
  assert.equal(body.fasting.active, null, 'another member active fast must never enter this personal widget');
  assert.equal(body.fasting.lastCompleted?.id, ownerCompleted);
  assert.equal(body.fasting.settings.clock_mode, 'remaining');
});

test('a medication aggregation failure does not erase valid fasting state', async () => {
  database.exec('ALTER TABLE medication_schedules RENAME TO medication_schedules_unavailable');
  try {
    const body = await dashboard();
    assert.equal(body.health.hasMeds, false, 'the medication slice uses its empty failure payload');
    assert.equal(body.fasting.lastCompleted?.id, ownerCompleted,
      'the independently loaded fasting widget remains available');
  } finally {
    database.exec('ALTER TABLE medication_schedules_unavailable RENAME TO medication_schedules');
  }
});

test('dashboard fasting payload is null when the capability is denied', async () => {
  setPermission(OWNER, 'capability', 'health_use_fasting', 'none');
  try {
    const body = await dashboard();
    assert.equal(body.fasting, null);
    assert.equal(body.health.hasMeds, true, 'a fasting capability denial must not erase other Health data');
  } finally {
    setPermission(OWNER, 'capability', 'health_use_fasting', 'allow');
  }
});

test('dashboard fasting payload follows Health module and API-token scope denial', async () => {
  setPermission(OWNER, 'module', 'health', 'none');
  try {
    assert.equal((await dashboard()).fasting, null, 'Health none must use the denied payload');
  } finally {
    database.prepare(`
      DELETE FROM access_permissions
      WHERE subject_type = 'user' AND subject_id = ? AND resource_type = 'module' AND resource_key = 'health'
    `).run(String(OWNER));
  }

  tokenScopes = ['dashboard:read'];
  try {
    const body = await dashboard();
    assert.equal(body.fasting, null, 'a token without health scope must use the denied payload');
    assert.equal(body.health.hasMeds, false, 'the Health denied payload must cover the entire Health slice');
  } finally {
    tokenScopes = null;
  }
});
