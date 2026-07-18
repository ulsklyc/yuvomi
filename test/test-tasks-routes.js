/**
 * Modul: Tasks-Routen (Härtung)
 * Zweck: End-to-End über den echten Router - die zuvor ungetesteten
 *        Zweige: PUT /:id (Vollupdate inkl. Zuweisungs-Replace, Punkte-Clamp,
 *        Sichtbarkeit, Housekeeping-/Reward-Kopplung), GET /meta/options,
 *        Kategorie-Umbenennen/Löschen (404/400/409), Listen-Filter, POST-
 *        Verschachtelung (Parent-404, Tiefenlimit), PATCH-Status (400/404),
 *        DELETE (404). Die Feature-Suiten (recurrence, multi-assignment,
 *        visibility, task-documents) decken andere Aspekte ab; hier geht es um
 *        die Route-/Validierungs-Schicht.
 * Ausführen: npm run test:tasks-routes
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'tasks-routes-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

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

const ALICE = seedUser('alice', 'admin');
const BOB   = seedUser('bob', 'member');
const WORKER = seedUser('worker', 'member');
// Housekeeping-Kraft: muss aus /meta/options-Nutzern ausgeschlossen werden.
db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 0)').run(WORKER);

// Aktueller Akteur (Middleware liest ihn zur Request-Zeit).
let actor = { id: ALICE, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Eine gültige Kategorie fixieren (aus den migrierten Defaults).
let CATEGORY;
test('setup: Default-Kategorien vorhanden', async () => {
  const r = await call('GET', '/categories', { as: { id: ALICE, role: 'admin' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 2);
  CATEGORY = r.body.data[0].key;
});

// --------------------------------------------------------
// POST: Punkte-Clamp, Verschachtelung (Parent-404, Tiefenlimit)
// --------------------------------------------------------
let PARENT, SUB;
test('POST: Punkte über dem Maximum werden auf 10000 geklemmt', async () => {
  const r = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Viele Punkte', points: 99999 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.points, 10000);
});

test('POST: Subtask unter Parent erlaubt; unbekannter Parent → 404', async () => {
  const parent = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Elternaufgabe', category: CATEGORY } });
  PARENT = parent.body.data.id;
  const sub = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Unteraufgabe', parent_task_id: PARENT } });
  assert.equal(sub.status, 201);
  SUB = sub.body.data.id;
  const missing = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Waise', parent_task_id: 999999 } });
  assert.equal(missing.status, 404);
});

test('POST: dritte Verschachtelungsebene → 400', async () => {
  const r = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Zu tief', parent_task_id: SUB } });
  assert.equal(r.status, 400);
});

test('POST: ungültige Priorität → 400', async () => {
  const r = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'X', priority: 'sofort' } });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------
// GET-Filter + GET /:id
// --------------------------------------------------------
test('GET /: Filter status/priority/category/assigned_to greifen', async () => {
  await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Dringend offen', priority: 'urgent', status: 'open', category: CATEGORY, assigned_to: [BOB] } });
  const byStatus = await call('GET', '/?status=open', { as: { id: ALICE, role: 'admin' } });
  assert.ok(byStatus.body.data.every((t) => t.status === 'open'));
  const byPriority = await call('GET', '/?priority=urgent', { as: { id: ALICE, role: 'admin' } });
  assert.ok(byPriority.body.data.some((t) => t.title === 'Dringend offen'));
  const byCategory = await call('GET', `/?category=${CATEGORY}`, { as: { id: ALICE, role: 'admin' } });
  assert.ok(byCategory.body.data.every((t) => t.category === CATEGORY));
  const byAssignee = await call('GET', `/?assigned_to=${BOB}`, { as: { id: ALICE, role: 'admin' } });
  assert.ok(byAssignee.body.data.some((t) => t.title === 'Dringend offen'));
});

test('GET /: include_future blendet zukünftige Startdaten ein/aus', async () => {
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Zukunfts-Task', start_date: future } });
  const fid = created.body.data.id;
  const def = await call('GET', '/', { as: { id: ALICE, role: 'admin' } });
  assert.ok(!def.body.data.some((t) => t.id === fid), 'zukünftige Aufgabe standardmäßig ausgeblendet');
  const withFuture = await call('GET', '/?include_future=1', { as: { id: ALICE, role: 'admin' } });
  assert.ok(withFuture.body.data.some((t) => t.id === fid), 'mit include_future sichtbar');
});

test('GET /:id: unbekannte ID → 404', async () => {
  const r = await call('GET', '/999999', { as: { id: ALICE, role: 'admin' } });
  assert.equal(r.status, 404);
});

// --------------------------------------------------------
// PUT /:id: Vollupdate, Zuweisungs-Replace, Sichtbarkeit, Punkte
// --------------------------------------------------------
test('PUT /:id: aktualisiert Felder, ersetzt Zuweisungen, klemmt Punkte', async () => {
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Ur-Titel', category: CATEGORY, assigned_to: [ALICE] } });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`, {
    as: { id: ALICE, role: 'admin' },
    body: { title: 'Neu-Titel', description: 'Beschreibung', priority: 'high', status: 'in_progress', category: CATEGORY, assigned_to: [BOB], points: 99999, visibility: 'all' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, 'Neu-Titel');
  assert.equal(r.body.data.priority, 'high');
  assert.equal(r.body.data.status, 'in_progress');
  assert.equal(r.body.data.points, 10000, 'Punkte geklemmt');
  assert.equal(r.body.data.assigned_users.length, 1);
  assert.equal(r.body.data.assigned_users[0].id, BOB, 'Zuweisung ersetzt');
  assert.ok(Array.isArray(r.body.data.subtasks));
});

test('PUT /:id: ohne assigned_to bleiben bestehende Zuweisungen erhalten', async () => {
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Behalte-Zuweisung', assigned_to: [ALICE, BOB] } });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`, { as: { id: ALICE, role: 'admin' }, body: { title: 'Nur Titel neu' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.assigned_users.length, 2, 'Zuweisungen unverändert');
});

test('PUT /:id: unbekannte ID → 404, ungültiger Status → 400', async () => {
  const missing = await call('PUT', '/999999', { as: { id: ALICE, role: 'admin' }, body: { title: 'X' } });
  assert.equal(missing.status, 404);
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Statusprobe' } });
  const bad = await call('PUT', `/${created.body.data.id}`, { as: { id: ALICE, role: 'admin' }, body: { status: 'erledigt-vielleicht' } });
  assert.equal(bad.status, 400);
});

// --------------------------------------------------------
// PATCH /:id/status, DELETE /:id
// --------------------------------------------------------
test('PATCH /:id/status: ungültiger Status → 400, unbekannte ID → 404', async () => {
  const bad = await call('PATCH', '/1/status', { as: { id: ALICE, role: 'admin' }, body: { status: 'quatsch' } });
  assert.equal(bad.status, 400);
  const missing = await call('PATCH', '/999999/status', { as: { id: ALICE, role: 'admin' }, body: { status: 'done' } });
  assert.equal(missing.status, 404);
});

test('PATCH /:id/status: gültiger Wechsel persistiert', async () => {
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Statuswechsel' } });
  const id = created.body.data.id;
  const r = await call('PATCH', `/${id}/status`, { as: { id: ALICE, role: 'admin' }, body: { status: 'done' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'done');
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
  assert.equal(row.status, 'done');
});

test('DELETE /:id: Erfolg (204/ok) und unbekannte ID → 404', async () => {
  const created = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Löschbar' } });
  const del = await call('DELETE', `/${created.body.data.id}`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
  const missing = await call('DELETE', '/999999', { as: { id: ALICE, role: 'admin' } });
  assert.equal(missing.status, 404);
});

// --------------------------------------------------------
// GET /meta/options
// --------------------------------------------------------
test('GET /meta/options: Nutzer (ohne Housekeeping-Kraft) + Enum-Listen', async () => {
  const r = await call('GET', '/meta/options', { as: { id: ALICE, role: 'admin' } });
  assert.equal(r.status, 200);
  const ids = r.body.users.map((u) => u.id);
  assert.ok(ids.includes(ALICE) && ids.includes(BOB));
  assert.ok(!ids.includes(WORKER), 'Housekeeping-Kraft ausgeschlossen');
  assert.deepEqual(r.body.priorities, ['none', 'low', 'medium', 'high', 'urgent']);
  assert.deepEqual(r.body.statuses, ['open', 'in_progress', 'done', 'archived']);
  assert.ok(Array.isArray(r.body.categories) && r.body.categories.length >= 2);
});

// --------------------------------------------------------
// Kategorie umbenennen / löschen (404/400/409)
// --------------------------------------------------------
test('PUT /categories/:key: umbenennen, 404, leerer Name 400, Konflikt 409', async () => {
  // Zwei frische Kategorien anlegen, um Konflikt/Umbenennung isoliert zu prüfen.
  const a = await call('POST', '/categories', { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Alpha' } });
  const b = await call('POST', '/categories', { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Beta' } });
  assert.equal(a.status, 201);

  const renamed = await call('PUT', `/categories/${a.body.data.key}`, { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Alpha-2' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.name, 'Kat-Alpha-2');
  assert.equal(renamed.body.data.label_key, null);

  const missing = await call('PUT', '/categories/gibtsnicht', { as: { id: ALICE, role: 'admin' }, body: { name: 'X' } });
  assert.equal(missing.status, 404);

  const empty = await call('PUT', `/categories/${a.body.data.key}`, { as: { id: ALICE, role: 'admin' }, body: { name: '' } });
  assert.equal(empty.status, 400);

  const conflict = await call('PUT', `/categories/${a.body.data.key}`, { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Beta' } });
  assert.equal(conflict.status, 409);
});

test('DELETE /categories/:key: 404, in Benutzung 409, danach Erfolg', async () => {
  const cat = await call('POST', '/categories', { as: { id: ALICE, role: 'admin' }, body: { name: 'Kat-Weg' } });
  const key = cat.body.data.key;

  const missing = await call('DELETE', '/categories/gibtsnicht', { as: { id: ALICE, role: 'admin' } });
  assert.equal(missing.status, 404);

  // In Benutzung: eine Aufgabe referenziert die Kategorie.
  const task = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Nutzt Kat', category: key } });
  const inUse = await call('DELETE', `/categories/${key}`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.reason, 'category_in_use');

  // Referenz lösen, dann löschbar.
  await call('DELETE', `/${task.body.data.id}`, { as: { id: ALICE, role: 'admin' } });
  const ok = await call('DELETE', `/categories/${key}`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(ok.status, 204);
});
