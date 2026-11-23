/**
 * Test: Konfigurierbare Standard-Punkte für Aufgaben (#578)
 * Zweck: Deckt die Invarianten des Features ab —
 *        - tasks_default_points ist admin-only und wird validiert (0..10000)
 *        - POST /tasks übernimmt den Standard nur ohne expliziten Wert und nur
 *          für Hauptaufgaben (Subtasks würden den Wert sonst vervielfachen)
 *        - eine ausdrückliche 0 überschreibt den Standard
 *        - /points/affected und /points/rebase sind beide admin-only
 *        - beide erfassen alle NICHT erledigten Hauptaufgaben auf dem Altwert,
 *          auch archivierte: nur für 'done' hält der reward_ledger eine
 *          earn-Buchung, alles andere ist buchungsfrei
 *        - Aufgaben mit eigenem Punktwert bleiben unberührt
 * Ausführen: npm run test:task-default-points
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-default-points-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { createTasksApp } = await import('./tasks-app.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

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
  for (const migration of migrations) applyMigration(database, migration);
  return database;
}

function seedUser(prefix, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

const ADMIN  = seedUser('admin', 'admin');
const MEMBER = seedUser('member', 'member');

let actor = { id: ADMIN, role: 'admin' };
const app = await createTasksApp({
  auth: (req, _res, next) => {
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.session = { userId: actor.id, role: actor.role };
    next();
  },
  after: [
    ['/api/v1/preferences', preferencesRouter],
  ],
});
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/api/v1`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const asAdmin  = { id: ADMIN,  role: 'admin' };
const asMember = { id: MEMBER, role: 'member' };

const setDefault = (points, as = asAdmin) =>
  call('PUT', '/preferences', { as, body: { tasks_default_points: points } });

// --------------------------------------------------------
// Preference: Default, Validierung, Admin-Gate
// --------------------------------------------------------

test('GET /preferences: tasks_default_points ist standardmäßig 0 (Feature aus)', async () => {
  const r = await call('GET', '/preferences', { as: asAdmin });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.tasks_default_points, 0);
});

test('PUT /preferences: Admin speichert den Standard, GET liefert ihn zurück', async () => {
  const put = await setDefault(10);
  assert.equal(put.status, 200);
  assert.equal(put.body.data.tasks_default_points, 10);

  const getRes = await call('GET', '/preferences', { as: asAdmin });
  assert.equal(getRes.body.data.tasks_default_points, 10);
});

test('PUT /preferences: Nicht-Admin bekommt 403', async () => {
  const r = await setDefault(25, asMember);
  assert.equal(r.status, 403);

  const getRes = await call('GET', '/preferences', { as: asAdmin });
  assert.equal(getRes.body.data.tasks_default_points, 10, 'Wert unverändert');
});

for (const invalid of [-1, 10001, 7.5, 'zehn']) {
  test(`PUT /preferences: ungültiger Standard ${JSON.stringify(invalid)} → 400`, async () => {
    const r = await setDefault(invalid);
    assert.equal(r.status, 400);
  });
}

// --------------------------------------------------------
// Anwendung beim Anlegen
// --------------------------------------------------------

test('GET /tasks/meta/options liefert den Standard an den Client', async () => {
  const r = await call('GET', '/tasks/meta/options', { as: asAdmin });
  assert.equal(r.status, 200);
  assert.equal(r.body.default_points, 10);
});

test('POST /tasks ohne points übernimmt den Standard', async () => {
  const r = await call('POST', '/tasks', { as: asAdmin, body: { title: 'Ohne Punkte' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.points, 10);
});

test('POST /tasks mit eigenem Wert überschreibt den Standard', async () => {
  const r = await call('POST', '/tasks', { as: asAdmin, body: { title: 'Eigener Wert', points: 50 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.points, 50);
});

test('POST /tasks mit points=0 setzt den Standard bewusst außer Kraft', async () => {
  const r = await call('POST', '/tasks', { as: asAdmin, body: { title: 'Punktelos', points: 0 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.points, 0);
});

test('POST /tasks: Subtasks erben den Standard nicht', async () => {
  const parent = await call('POST', '/tasks', { as: asAdmin, body: { title: 'Elternaufgabe' } });
  assert.equal(parent.body.data.points, 10);

  const sub = await call('POST', '/tasks', {
    as: asAdmin,
    body: { title: 'Unteraufgabe', parent_task_id: parent.body.data.id },
  });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.data.points, 0);
});

test('POST /tasks: bei Standard 0 bleibt das Verhalten wie bisher', async () => {
  await setDefault(0);
  const r = await call('POST', '/tasks', { as: asAdmin, body: { title: 'Kein Standard aktiv' } });
  assert.equal(r.body.data.points, 0);
  await setDefault(10);
});

// --------------------------------------------------------
// Nachziehen bestehender Aufgaben
// --------------------------------------------------------

// Frisches Feld für die Rebase-Prüfungen: alles Vorherige aus dem Weg räumen.
test('setup: Aufgaben-Tabelle für die Rebase-Fälle leeren', () => {
  db.prepare('DELETE FROM tasks').run();
});

function seedTask(title, points, status = 'open') {
  return db.prepare(`
    INSERT INTO tasks (title, category, priority, status, created_by, points)
    VALUES (?, 'misc', 'none', ?, ?, ?)
  `).run(title, status, ADMIN, points).lastInsertRowid;
}

test('GET /points/affected zählt alle nicht erledigten Hauptaufgaben auf dem Altwert', async () => {
  seedTask('offen A', 10);
  seedTask('offen B', 10);
  seedTask('in Arbeit', 10, 'in_progress');
  seedTask('eigener Wert', 50);
  seedTask('erledigt', 10, 'done');
  // Archiviert zählt mit: ohne 'done' gibt es keine Ledger-Buchung, und eine
  // später reaktivierte Aufgabe soll keinen veralteten Wert auszahlen.
  seedTask('archiviert', 10, 'archived');

  const r = await call('GET', '/tasks/points/affected?points=10', { as: asAdmin });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.count, 4);
});

test('GET /points/affected: ungültiger Wert → 400', async () => {
  const r = await call('GET', '/tasks/points/affected?points=abc', { as: asAdmin });
  assert.equal(r.status, 400);
});

test('GET /points/affected: Nicht-Admin bekommt 403', async () => {
  const r = await call('GET', '/tasks/points/affected?points=10', { as: asMember });
  assert.equal(r.status, 403);
});

test('POST /points/rebase: Nicht-Admin bekommt 403', async () => {
  const r = await call('POST', '/tasks/points/rebase', { as: asMember, body: { from: 10, to: 15 } });
  assert.equal(r.status, 403);
});

test('POST /points/rebase: from=0 wird abgelehnt (fasst sonst jede punktelose Aufgabe an)', async () => {
  const r = await call('POST', '/tasks/points/rebase', { as: asAdmin, body: { from: 0, to: 15 } });
  assert.equal(r.status, 400);
});

test('POST /points/rebase: zieht alles Unerledigte nach, lässt erledigte unberührt', async () => {
  const r = await call('POST', '/tasks/points/rebase', { as: asAdmin, body: { from: 10, to: 15 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.updated, 4);

  const byTitle = (title) => db.prepare('SELECT points FROM tasks WHERE title = ?').get(title).points;
  assert.equal(byTitle('offen A'), 15);
  assert.equal(byTitle('offen B'), 15);
  assert.equal(byTitle('in Arbeit'), 15);
  assert.equal(byTitle('archiviert'), 15, 'archiviert ist buchungsfrei und wandert mit');
  assert.equal(byTitle('eigener Wert'), 50, 'eigener Punktwert bleibt');
  assert.equal(byTitle('erledigt'), 10, 'bereits gebuchte Punkte bleiben');
});

test('POST /points/rebase: Subtasks werden nicht mitgezogen', async () => {
  const parent = seedTask('Parent für Subtask', 15);
  db.prepare(`
    INSERT INTO tasks (title, category, priority, status, created_by, points, parent_task_id)
    VALUES ('Subtask mit Punkten', 'misc', 'none', 'open', ?, 15, ?)
  `).run(ADMIN, parent);

  const r = await call('POST', '/tasks/points/rebase', { as: asAdmin, body: { from: 15, to: 20 } });
  assert.equal(r.status, 200);

  const sub = db.prepare("SELECT points FROM tasks WHERE title = 'Subtask mit Punkten'").get();
  assert.equal(sub.points, 15);
});

test('POST /points/rebase: from === to ist ein No-op', async () => {
  const r = await call('POST', '/tasks/points/rebase', { as: asAdmin, body: { from: 20, to: 20 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.updated, 0);
});
