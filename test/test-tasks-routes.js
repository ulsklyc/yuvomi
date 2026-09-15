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
import Database from 'better-sqlite3-multiple-ciphers';
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

// --------------------------------------------------------
// GET /: Mehrfachauswahl je Achse (#671)
//
// Gemeldet: "Filtering the tasklist for e.g. priority only allows one value to
// be filtered by per row/attribute". Innerhalb einer Achse muss ODER gelten -
// eine Aufgabe trägt genau EINE Priorität, ein UND wäre garantiert leer.
// Zwischen den Achsen bleibt es UND.
// --------------------------------------------------------
test('GET /: mehrere Prioritäten verknüpfen sich ODER', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const mk = (title, priority, status = 'open') =>
    call('POST', '/', { as: admin, body: { title, priority, status } });

  const marker = `prio-${randomUUID().slice(0, 8)}`;
  await mk(`${marker}-hoch`, 'high');
  await mk(`${marker}-mittel`, 'medium');
  await mk(`${marker}-niedrig`, 'low');

  const mine = (rows) => rows.filter((r) => r.title.startsWith(marker)).map((r) => r.priority).sort();

  const single = await call('GET', '/?priority=high', { as: admin });
  assert.deepEqual(mine(single.body.data), ['high'], 'ein Wert filtert wie bisher');

  const both = await call('GET', '/?priority=high&priority=medium', { as: admin });
  assert.deepEqual(mine(both.body.data), ['high', 'medium'], 'zwei Werte liefern beide Gruppen');

  const all = await call('GET', '/?priority=high&priority=medium&priority=low', { as: admin });
  assert.deepEqual(mine(all.body.data), ['high', 'low', 'medium']);
});

test('GET /: mehrere Status verknüpfen sich ODER, Achsen untereinander UND', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const marker = `mix-${randomUUID().slice(0, 8)}`;
  await call('POST', '/', { as: admin, body: { title: `${marker}-a`, status: 'open', priority: 'high' } });
  await call('POST', '/', { as: admin, body: { title: `${marker}-b`, status: 'in_progress', priority: 'high' } });
  await call('POST', '/', { as: admin, body: { title: `${marker}-c`, status: 'in_progress', priority: 'low' } });

  const titles = (rows) => rows.filter((r) => r.title.startsWith(marker)).map((r) => r.title).sort();

  const twoStatus = await call('GET', '/?status=open&status=in_progress', { as: admin });
  assert.deepEqual(titles(twoStatus.body.data), [`${marker}-a`, `${marker}-b`, `${marker}-c`]);

  // Achsen-Kombination engt ein: (open ODER in_progress) UND Priorität hoch.
  const narrowed = await call('GET', '/?status=open&status=in_progress&priority=high', { as: admin });
  assert.deepEqual(titles(narrowed.body.data), [`${marker}-a`, `${marker}-b`]);
});

test('GET /: mehrere Personen verknüpfen sich ODER', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const marker = `wer-${randomUUID().slice(0, 8)}`;
  await call('POST', '/', { as: admin, body: { title: `${marker}-alice`, assigned_to: ALICE } });
  await call('POST', '/', { as: admin, body: { title: `${marker}-bob`, assigned_to: BOB } });
  await call('POST', '/', { as: admin, body: { title: `${marker}-niemand` } });

  const titles = (rows) => rows.filter((r) => r.title.startsWith(marker)).map((r) => r.title).sort();

  const one = await call('GET', `/?assigned_to=${BOB}`, { as: admin });
  assert.deepEqual(titles(one.body.data), [`${marker}-bob`]);

  const two = await call('GET', `/?assigned_to=${ALICE}&assigned_to=${BOB}`, { as: admin });
  assert.deepEqual(titles(two.body.data), [`${marker}-alice`, `${marker}-bob`]);
});

test('GET /: ein leerer oder unsinniger Wert engt nicht versehentlich ein', async () => {
  const admin = { id: ALICE, role: 'admin' };
  // Ein leerer Parameter darf nicht als Wert "" gelten und alles wegfiltern.
  const empty = await call('GET', '/?priority=', { as: admin });
  const unfiltered = await call('GET', '/', { as: admin });
  assert.equal(empty.body.data.length, unfiltered.body.data.length);

  // Eine nicht-numerische Person wird verworfen, statt die Query zu sprengen.
  const bogus = await call('GET', '/?assigned_to=abc', { as: admin });
  assert.equal(bogus.status, 200);
  assert.equal(bogus.body.data.length, unfiltered.body.data.length);
});

// --------------------------------------------------------
// Archiv als eigene Achse (#688)
//
// Gemeldet war: eine erledigte Aufgabe kam nach dem Archivieren als unerledigt
// zurück und stand danach in "Heute auf einen Blick", wo sie sich nicht öffnen
// ließ. Ursache war ein überladenes Statusfeld - das Ablegen überschrieb das
// Erledigt-Sein. Diese Tests halten die Trennung fest.
// --------------------------------------------------------
test('Archivieren lässt den Status stehen - auch erledigt bleibt erledigt', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const created = await call('POST', '/', { as: admin, body: { title: `arch-${randomUUID().slice(0, 8)}` } });
  const id = created.body.data.id;

  await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'done' } });
  const archived = await call('PATCH', `/${id}/archive`, { as: admin, body: { archived: true } });

  assert.equal(archived.status, 200);
  assert.equal(archived.body.data.status, 'done', 'der Status darf sich beim Ablegen nicht ändern');
  assert.ok(archived.body.data.archived_at, 'archived_at wird gesetzt');

  const row = await call('GET', `/${id}`, { as: admin });
  assert.equal(row.body.data.status, 'done');
  assert.ok(row.body.data.archived_at);
});

test('PATCH /status mit "archived" legt ab, statt den Status zu überschreiben', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const created = await call('POST', '/', { as: admin, body: { title: `legacy-${randomUUID().slice(0, 8)}` } });
  const id = created.body.data.id;
  await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'done' } });

  // Der Weg, den Bestandsclients und die MCP-Brücke nehmen.
  const r = await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'archived' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'done');
  assert.ok(r.body.data.archived_at);

  // Dasselbe über das Vollupdate.
  const other = await call('POST', '/', { as: admin, body: { title: `legacy-put-${randomUUID().slice(0, 8)}` } });
  await call('PATCH', `/${other.body.data.id}/status`, { as: admin, body: { status: 'in_progress' } });
  const put = await call('PUT', `/${other.body.data.id}`, { as: admin, body: { title: 'unverändert', status: 'archived' } });
  assert.equal(put.body.data.status, 'in_progress');
  assert.ok(put.body.data.archived_at);
});

test('Zurückholen setzt den Status nicht zurück', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const created = await call('POST', '/', { as: admin, body: { title: `back-${randomUUID().slice(0, 8)}` } });
  const id = created.body.data.id;
  await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'done' } });
  await call('PATCH', `/${id}/archive`, { as: admin, body: { archived: true } });

  const back = await call('PATCH', `/${id}/archive`, { as: admin, body: { archived: false } });
  assert.equal(back.body.data.status, 'done', 'gemeldet war genau das Gegenteil: sie kam als offen zurück');
  assert.equal(back.body.data.archived_at, null);
});

test('GET /: Abgelegtes bleibt draußen, bis danach gefragt wird', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const marker = `sicht-${randomUUID().slice(0, 8)}`;
  await call('POST', '/', { as: admin, body: { title: `${marker}-offen` } });
  const b = await call('POST', '/', { as: admin, body: { title: `${marker}-abgelegt` } });
  await call('PATCH', `/${b.body.data.id}/archive`, { as: admin, body: { archived: true } });

  const titles = (rows) => rows.filter((r) => r.title.startsWith(marker)).map((r) => r.title).sort();

  const plain = await call('GET', '/', { as: admin });
  assert.deepEqual(titles(plain.body.data), [`${marker}-offen`]);

  // Der Statusfilter allein holt die abgelegte Aufgabe NICHT zurück, obwohl sie
  // weiter auf 'open' steht - genau daran hing die Beobachtung im Dashboard.
  const byStatus = await call('GET', '/?status=open', { as: admin });
  assert.deepEqual(titles(byStatus.body.data), [`${marker}-offen`]);

  const included = await call('GET', '/?archived=1', { as: admin });
  assert.deepEqual(titles(included.body.data), [`${marker}-abgelegt`, `${marker}-offen`]);

  const only = await call('GET', '/?archived=only', { as: admin });
  assert.deepEqual(titles(only.body.data), [`${marker}-abgelegt`]);

  // Der Filterchip der Oberfläche spricht weiter über den Statusparameter.
  const chip = await call('GET', '/?status=archived', { as: admin });
  assert.deepEqual(titles(chip.body.data), [`${marker}-abgelegt`]);

  // Und kombiniert bleibt es eine ODER-Achse wie jede andere.
  const both = await call('GET', '/?status=open&status=archived', { as: admin });
  assert.deepEqual(titles(both.body.data), [`${marker}-abgelegt`, `${marker}-offen`]);
});

test('Ablegen storniert keine Punkte-Gutschrift', async () => {
  const admin = { id: ALICE, role: 'admin' };
  db.prepare('INSERT OR REPLACE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(BOB);

  const created = await call('POST', '/', { as: admin, body: { title: `punkte-${randomUUID().slice(0, 8)}`, points: 7, assigned_to: [BOB] } });
  const id = created.body.data.id;
  await call('PATCH', `/${id}/status`, { as: admin, body: { status: 'done' } });

  const earned = () => db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM reward_ledger WHERE task_id = ? AND type = 'earn'").get(id).n;
  assert.equal(earned(), 7, 'Erledigen bucht');

  await call('PATCH', `/${id}/archive`, { as: admin, body: { archived: true } });
  assert.equal(earned(), 7, 'Ablegen ist keine Rücknahme des Erledigens');
});

// --------------------------------------------------------
// Sync-Ziel einer neuen Aufgabe (#695)
// --------------------------------------------------------

function seedReminderList({ module = 'tasks', enabled = 1, url = 'https://dav.example/dav/u/reminders/' } = {}) {
  // Ein eigenes Konto je Aufruf: (caldav_url, username) ist eindeutig.
  const user = `u-${randomUUID().slice(0, 8)}`;
  const accountId = db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('Synology', 'https://dav.example/', ?, 'p')
  `).run(user).lastInsertRowid;
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'Inbox', ?, ?)
  `).run(accountId, url, module, enabled);
  return { accountId, url };
}

test('GET /sync-targets liefert nur die fuer Aufgaben freigegebenen Listen', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const tasksList = seedReminderList();
  seedReminderList({ module: 'shopping', url: 'https://dav.example/dav/u/einkauf/' });
  seedReminderList({ enabled: 0, url: 'https://dav.example/dav/u/aus/' });

  const r = await call('GET', '/sync-targets', { as: admin });
  assert.equal(r.status, 200);
  const urls = new Set(r.body.data.caldav.map((entry) => entry.listUrl));
  assert.ok(urls.has(tasksList.url));
  assert.ok(!urls.has('https://dav.example/dav/u/einkauf/'),
    'Eine Einkaufsliste als Ziel brächte die Aufgabe als Einkaufsposten zurück');
  assert.ok(!urls.has('https://dav.example/dav/u/aus/'));
  // Kein Feld, das mehr verrät als das Dropdown braucht.
  for (const entry of r.body.data.caldav) {
    assert.deepEqual(Object.keys(entry).sort(), ['accountId', 'accountName', 'listName', 'listUrl']);
  }
});

test('POST mit Sync-Ziel merkt die Aufgabe fuer den Upload vor', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const { accountId, url } = seedReminderList({ url: 'https://dav.example/dav/u/ziel-ok/' });

  const r = await call('POST', '/', {
    as: admin,
    body: { title: 'Reifen wechseln', sync_target: `caldav:${accountId}|${url}` },
  });
  assert.equal(r.status, 201);

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.body.data.id);
  assert.equal(row.target_caldav_account_id, accountId);
  assert.equal(row.target_caldav_list_url, url);
  // Sie bleibt bis zum Upload lokal - erst der Sync macht sie zum Spiegel.
  assert.equal(row.external_source, 'local');
});

test('POST ohne Sync-Ziel laesst die Aufgabe lokal, wie jede bisher', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const r = await call('POST', '/', { as: admin, body: { title: 'Nur hier' } });
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.body.data.id);
  assert.equal(row.target_caldav_account_id, null);
  assert.equal(row.target_caldav_list_url, null);
});

test('POST mit einer nicht freigegebenen Liste → 400 statt stiller Wartestellung', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const { accountId } = seedReminderList({ enabled: 0, url: 'https://dav.example/dav/u/abgewaehlt/' });

  const r = await call('POST', '/', {
    as: admin,
    body: { title: 'Ins Leere', sync_target: `caldav:${accountId}|https://dav.example/dav/u/abgewaehlt/` },
  });
  assert.equal(r.status, 400);
});

test('POST mit einem Google-Ziel → 400: Aufgaben gleichen nur ueber CalDAV ab', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const r = await call('POST', '/', { as: admin, body: { title: 'Falsches Ziel', sync_target: 'google:primary' } });
  assert.equal(r.status, 400);
});

test('POST mit kaputtem Ziel-Format → 400', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const r = await call('POST', '/', { as: admin, body: { title: 'Kaputt', sync_target: 'caldav:' } });
  assert.equal(r.status, 400);
});

test('Eine Unteraufgabe bekommt kein eigenes Ziel, auch wenn eines mitkommt', async () => {
  // Als eigenstaendiges VTODO stuende sie gleichrangig neben ihrer Elternaufgabe.
  // Das Feld wird deshalb still verworfen statt mit 400 mitten im Anlegen einer
  // Checkliste abgewiesen.
  const admin = { id: ALICE, role: 'admin' };
  const { accountId, url } = seedReminderList({ url: 'https://dav.example/dav/u/sub/' });
  const parent = await call('POST', '/', { as: admin, body: { title: 'Umzug' } });

  const sub = await call('POST', '/', {
    as: admin,
    body: { title: 'Kartons', parent_task_id: parent.body.data.id, sync_target: `caldav:${accountId}|${url}` },
  });
  assert.equal(sub.status, 201);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(sub.body.data.id);
  assert.equal(row.target_caldav_account_id, null);
});

test('PUT setzt ein Ziel nach und nimmt es mit leerem Wert zurueck', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const { accountId, url } = seedReminderList({ url: 'https://dav.example/dav/u/nachtraeglich/' });
  const created = await call('POST', '/', { as: admin, body: { title: 'Spaeter doch' } });
  const id = created.body.data.id;

  await call('PUT', `/${id}`, { as: admin, body: { title: 'Spaeter doch', sync_target: `caldav:${accountId}|${url}` } });
  assert.equal(db.prepare('SELECT target_caldav_list_url AS u FROM tasks WHERE id = ?').get(id).u, url);

  await call('PUT', `/${id}`, { as: admin, body: { title: 'Spaeter doch', sync_target: '' } });
  assert.equal(db.prepare('SELECT target_caldav_list_url AS u FROM tasks WHERE id = ?').get(id).u, null);
});

test('Eine bereits hochgeladene Aufgabe wechselt ihre Liste nicht', async () => {
  // Einen Umzug zwischen Listen gibt es bewusst nicht. Das Feld wird still
  // ignoriert, weil der Dialog es in diesem Zustand gar nicht als Auswahl zeigt.
  const admin = { id: ALICE, role: 'admin' };
  const { accountId, url } = seedReminderList({ url: 'https://dav.example/dav/u/schon-oben/' });
  const created = await call('POST', '/', { as: admin, body: { title: 'Laengst oben' } });
  const id = created.body.data.id;
  db.prepare(`
    UPDATE tasks SET external_source = 'caldav', external_uid = 'x@y', external_account_id = ?
     WHERE id = ?
  `).run(accountId, id);

  const r = await call('PUT', `/${id}`, { as: admin, body: { title: 'Laengst oben', sync_target: `caldav:${accountId}|${url}` } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT target_caldav_list_url AS u FROM tasks WHERE id = ?').get(id).u, null);
});

test('eine private Unteraufgabe bleibt in der Liste fremd und unantastbar (#748-Review)', async () => {
  const alice = { id: ALICE, role: 'admin' };
  const bob   = { id: BOB, role: 'member' };

  // Geteilte Elternaufgabe, darunter eine PRIVATE Unteraufgabe von Alice.
  const parent = await call('POST', '/', {
    as: alice, body: { title: 'Umzug', category: CATEGORY, visibility: 'all' },
  });
  assert.equal(parent.status, 201);
  const sub = await call('POST', '/', {
    as: alice,
    body: { title: 'Geheim: Kaution zurueckfordern', category: CATEGORY, parent_task_id: parent.body.data.id, visibility: 'private' },
  });
  assert.equal(sub.status, 201);
  const subId = sub.body.data.id;

  // 1) Die LISTE gab den Titel samt ID heraus, obwohl die Detailansicht ihn
  //    korrekt zurueckhielt - und zaehlte ihn im Fortschritt mit.
  const list = await call('GET', '/', { as: bob });
  assert.equal(list.status, 200);
  const seen = list.body.data.find((t) => t.id === parent.body.data.id);
  assert.ok(seen, 'die geteilte Elternaufgabe muss Bob erreichen');
  assert.deepEqual(seen.subtasks, [], 'fremde private Unteraufgabe in der Liste');
  assert.equal(seen.subtask_total, 0, 'fremde private Unteraufgabe im Zaehler');
  assert.equal(seen.subtask_done, 0);

  // 2) Und selbst mit der ID in der Hand kommt Bob nicht heran.
  assert.equal((await call('PUT', `/${subId}`, { as: bob, body: { title: 'entfuehrt' } })).status, 404);
  assert.equal((await call('DELETE', `/${subId}`, { as: bob })).status, 404);

  // 3) Fuer Alice ist alles unveraendert da.
  const own = await call('GET', '/', { as: alice });
  const mine = own.body.data.find((t) => t.id === parent.body.data.id);
  assert.equal(mine.subtask_total, 1);
  assert.deepEqual(mine.subtasks.map((s) => s.id), [subId]);
  assert.equal((await call('PUT', `/${subId}`, { as: alice, body: { title: 'Kaution zurueckfordern' } })).status, 200);
});

test('auch eine gewoehnliche fremde Aufgabe ist nicht loeschbar (#748-Review)', async () => {
  // Der Befund haengt nicht an Unteraufgaben: PUT und DELETE luden die Zeile per
  // id und arbeiteten darauf, ohne die Sichtbarkeit zu fragen.
  const priv = await call('POST', '/', {
    as: { id: ALICE, role: 'admin' },
    body: { title: 'Privat', category: CATEGORY, visibility: 'private' },
  });
  const id = priv.body.data.id;
  assert.equal((await call('PUT', `/${id}`, { as: { id: BOB, role: 'member' }, body: { title: 'x' } })).status, 404);
  assert.equal((await call('DELETE', `/${id}`, { as: { id: BOB, role: 'member' } })).status, 404);
  // Sie steht danach unveraendert da.
  const still = await call('GET', `/${id}`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(still.body.data.title, 'Privat');
});

// --------------------------------------------------------
// Kommentare an Aufgaben (#734)
// --------------------------------------------------------

let COMMENT_TASK, COMMENT_ID;

test('Kommentare: anlegen, lesen, in Reihenfolge', async () => {
  const task = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Küche streichen' } });
  COMMENT_TASK = task.body.data.id;

  const first = await call('POST', `/${COMMENT_TASK}/comments`, {
    as: { id: ALICE, role: 'admin' }, body: { comment: 'Farbe ist gekauft.' },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.comment, 'Farbe ist gekauft.');
  assert.equal(first.body.data.author_name, 'alice');
  assert.equal(first.body.data.updated_at, null);
  COMMENT_ID = first.body.data.id;

  await call('POST', `/${COMMENT_TASK}/comments`, {
    as: { id: BOB, role: 'member' }, body: { comment: 'Ich bringe die Rolle mit.' },
  });

  // Eine Unterhaltung liest sich vorwärts - ältester Beitrag zuerst.
  const list = await call('GET', `/${COMMENT_TASK}/comments`, { as: { id: BOB, role: 'member' } });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((c) => c.comment),
    ['Farbe ist gekauft.', 'Ich bringe die Rolle mit.']);
});

test('Kommentare: leer oder nur Leerzeichen → 400', async () => {
  for (const comment of ['', '   ', null]) {
    const res = await call('POST', `/${COMMENT_TASK}/comments`, {
      as: { id: ALICE, role: 'admin' }, body: { comment },
    });
    assert.equal(res.status, 400, `"${comment}" hätte 400 geben müssen`);
  }
});

test('Kommentare: ändern darf nur, wer geschrieben hat', async () => {
  const fremd = await call('PATCH', `/${COMMENT_TASK}/comments/${COMMENT_ID}`, {
    as: { id: BOB, role: 'member' }, body: { comment: 'Übernommen' },
  });
  assert.equal(fremd.status, 403);

  const eigen = await call('PATCH', `/${COMMENT_TASK}/comments/${COMMENT_ID}`, {
    as: { id: ALICE, role: 'admin' }, body: { comment: 'Farbe ist gekauft (2 Eimer).' },
  });
  assert.equal(eigen.status, 200);
  assert.equal(eigen.body.data.comment, 'Farbe ist gekauft (2 Eimer).');
  // Erst die Nachbesserung setzt den Stempel - sonst trüge jeder Beitrag einen.
  assert.ok(eigen.body.data.updated_at, 'updated_at fehlt nach dem Ändern');
});

test('Kommentare: löschen darf der Autor, und ein Admin zum Moderieren', async () => {
  const bobs = await call('POST', `/${COMMENT_TASK}/comments`, {
    as: { id: BOB, role: 'member' }, body: { comment: 'Doppelt geschrieben.' },
  });
  const bobsId = bobs.body.data.id;

  // Alice ist Admin und darf entfernen, obwohl sie nicht geschrieben hat.
  const moderiert = await call('DELETE', `/${COMMENT_TASK}/comments/${bobsId}`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(moderiert.status, 200);

  const eigener = await call('POST', `/${COMMENT_TASK}/comments`, {
    as: { id: BOB, role: 'member' }, body: { comment: 'Und wieder weg.' },
  });
  const selbst = await call('DELETE', `/${COMMENT_TASK}/comments/${eigener.body.data.id}`, { as: { id: BOB, role: 'member' } });
  assert.equal(selbst.status, 200);

  const rest = await call('GET', `/${COMMENT_TASK}/comments`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(rest.body.data.length, 2);
});

test('Kommentare: ein Mitglied ohne Admin-Rolle moderiert nicht', async () => {
  const alices = await call('POST', `/${COMMENT_TASK}/comments`, {
    as: { id: ALICE, role: 'admin' }, body: { comment: 'Steht hier.' },
  });
  const res = await call('DELETE', `/${COMMENT_TASK}/comments/${alices.body.data.id}`, { as: { id: BOB, role: 'member' } });
  assert.equal(res.status, 403);
});

test('Kommentare: eine private Aufgabe teilt ihre Unterhaltung nicht', async () => {
  const privat = await call('POST', '/', {
    as: { id: ALICE, role: 'admin' }, body: { title: 'Geheim', visibility: 'private' },
  });
  const id = privat.body.data.id;
  await call('POST', `/${id}/comments`, { as: { id: ALICE, role: 'admin' }, body: { comment: 'Nur für mich.' } });

  assert.equal((await call('GET', `/${id}/comments`, { as: { id: BOB, role: 'member' } })).status, 404);
  assert.equal((await call('POST', `/${id}/comments`, { as: { id: BOB, role: 'member' }, body: { comment: 'Hallo?' } })).status, 404);
});

test('Kommentare: eine gelöschte Aufgabe nimmt ihre Unterhaltung mit', async () => {
  const task = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Verschwindet' } });
  const id = task.body.data.id;
  await call('POST', `/${id}/comments`, { as: { id: ALICE, role: 'admin' }, body: { comment: 'Bleibt nicht.' } });
  await call('DELETE', `/${id}`, { as: { id: ALICE, role: 'admin' } });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_comments WHERE task_id = ?').get(id).c, 0);
});

test('Kommentare: erwähnt wird gegen dieselbe Personenliste wie im Browser', async () => {
  // Der Server las für die Benachrichtigung ALLE Nutzer, der Browser hebt gegen
  // `meta/options` hervor - und dort sind Haushaltskräfte ausgenommen. Ein Name,
  // den die Ansicht nicht markiert, darf auch keine Push-Meldung mit dem Titel
  // der Aufgabe und dem Kommentartext auslösen.
  const options = await call('GET', '/meta/options', { as: { id: ALICE, role: 'admin' } });
  const sichtbar = options.body.users.map((u) => u.id);
  assert.ok(!sichtbar.includes(WORKER), 'Vorbedingung: die Haushaltskraft steht nicht in meta/options');

  const { mentionedUserIds } = await import('../public/utils/mentions.js');
  const alleNutzer = db.prepare('SELECT id, display_name FROM users').all();
  const wieDerServer = db.prepare(`
    SELECT id, display_name FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
  `).all();

  const text = '@worker kannst du das übernehmen?';
  assert.deepEqual(mentionedUserIds(text, alleNutzer), [WORKER], 'Vorbedingung: der Name träfe ohne Ausschluss');
  assert.deepEqual(mentionedUserIds(text, wieDerServer), [], 'Haushaltskraft wird nicht benachrichtigt');
});

test('Kommentare: eine beim Bearbeiten dazugekommene Erwähnung wird gemeldet', async () => {
  // Wer beim Korrigieren jemanden dazuholt, meint ihn genauso wie beim
  // Schreiben - vorher lief die Benachrichtigung nur im POST-Pfad.
  const task = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Erwähnung nachtragen' } });
  const created = await call('POST', `/${task.body.data.id}/comments`, {
    as: { id: ALICE, role: 'admin' }, body: { comment: 'Wer macht das?' },
  });
  const patched = await call('PATCH', `/${task.body.data.id}/comments/${created.body.data.id}`, {
    as: { id: ALICE, role: 'admin' }, body: { comment: '@bob machst du das?' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.comment, '@bob machst du das?');

  // Die Route liest die Empfänger aus dem Text und nur die NEUEN: eine zweite
  // Korrektur an derselben Erwähnung darf nicht noch einmal melden.
  const { mentionedUserIds } = await import('../public/utils/mentions.js');
  const users = db.prepare('SELECT id, display_name FROM users').all();
  const vorher = mentionedUserIds('Wer macht das?', users);
  const nachher = mentionedUserIds('@bob machst du das?', users);
  assert.deepEqual(nachher.filter((id) => !vorher.includes(id)), [BOB]);
  assert.deepEqual(nachher.filter((id) => !nachher.includes(id)), []);
});

test('Kommentare: wem das Modul entzogen ist, bekommt keine Erwähnungs-Meldung', async () => {
  // Sichtbarkeit der Zeile ist nicht die einzige Hürde: wem das Aufgaben-Modul
  // auf `none` steht, der kommt an die Aufgabe gar nicht heran - und bekäme mit
  // dem Push trotzdem ihren Titel und den Anfang des Kommentars zugestellt.
  const { resolvePermissions } = await import('../server/permissions.js');
  // subject_id wird als TEXT gehalten und auch so abgefragt (`loadSubjectRows`)
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'tasks', 'none')
  `).run(String(BOB));

  const bob = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(BOB);
  const perms = resolvePermissions(db, bob);
  assert.equal(perms.modules.tasks, 'none', 'Vorbedingung: Bob darf die Aufgaben nicht sehen');

  // Die Aufgabe selbst bleibt für ihn sichtbar (visibility `all`) - genau
  // deshalb reicht `findVisibleTask` als Prüfung nicht aus.
  const task = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Ohne Modulzugriff' } });
  const posted = await call('POST', `/${task.body.data.id}/comments`, {
    as: { id: ALICE, role: 'admin' }, body: { comment: '@bob liest das nicht' },
  });
  assert.equal(posted.status, 201);

  db.prepare("DELETE FROM access_permissions WHERE subject_id = ? AND resource_key = 'tasks'").run(String(BOB));
  const wieder = resolvePermissions(db, bob);
  assert.notEqual(wieder.modules.tasks, 'none', 'Aufräumen: Bobs Zugriff ist wiederhergestellt');
});

// --------------------------------------------------------
// Status beim Anlegen (#807)
//
// Der Dialog zeigte das Feld nur beim Bearbeiten, und der Server hatte den
// zweiten Halt: `validateTaskInput` prüfte einen mitgeschickten Status seit
// jeher, das INSERT schrieb ihn nie. Ein Wert, der validiert und dann still
// verworfen wird, ist die schlechtere Hälfte von beidem - deshalb prüfen die
// Tests nicht nur, DASS der Status ankommt, sondern dass er denselben Weg
// nimmt wie beim Abhaken.
// --------------------------------------------------------
test('POST: ohne Status bleibt es beim ersten Status', async () => {
  const r = await call('POST', '/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Ohne Status' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, 'open');
});

test('POST: mitgeschickter Status wird geschrieben, nicht still verworfen', async () => {
  const r = await call('POST', '/', {
    as: { id: ALICE, role: 'admin' },
    body: { title: 'Schon angefangen', status: 'in_progress' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, 'in_progress', 'Antwort trägt den Status');
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(r.body.data.id);
  assert.equal(row.status, 'in_progress', 'und die Zeile auch');
});

test('POST: erledigt angelegt bucht Punkte und schreibt den Verlauf', async () => {
  const admin = { id: ALICE, role: 'admin' };
  db.prepare('INSERT OR REPLACE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(BOB);

  const r = await call('POST', '/', {
    as: admin,
    body: { title: `erledigt-angelegt-${randomUUID().slice(0, 8)}`, status: 'done', points: 5, assigned_to: [BOB] },
  });
  assert.equal(r.status, 201);
  const id = r.body.data.id;

  // Die Zahl kommt aus derselben Abfrage wie beim Abhaken weiter oben: ein
  // erledigt angelegter Vorgang darf nicht anders zählen als ein erledigt
  // abgehakter, sonst führen Punktekonto und Verlauf zwei Buchhaltungen.
  const earned = db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM reward_ledger WHERE task_id = ? AND type = 'earn'").get(id).n;
  assert.equal(earned, 5, 'Anlegen mit done bucht wie das Abhaken');

  const completions = db.prepare('SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ?').get(id).n;
  assert.equal(completions, 1, 'und steht im Verlauf');
});

test('POST: erledigt angelegte Serie legt die nächste Instanz nach', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const marker = `serie-${randomUUID().slice(0, 8)}`;
  // Die Fälligkeit liegt bewusst in der Zukunft. Liegt sie zurück, holt die
  // Serie beim Erledigen übersprungene Vorkommen bis heute auf (#658, gewollt),
  // und der Nachfolger hinge vom Tag des Testlaufs ab: mit '2026-09-07' war der
  // Test bis zum 14.09.2026 grün und ab dem 15.09. rot.
  const r = await call('POST', '/', {
    as: admin,
    body: {
      title: marker, status: 'done', due_date: '2099-09-07',
      is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
    },
  });
  assert.equal(r.status, 201);

  // Ohne den Nachfolger endete die Serie in dem Moment, in dem sie entsteht.
  const rows = db.prepare('SELECT status, due_date FROM tasks WHERE title = ? ORDER BY id').all(marker);
  assert.equal(rows.length, 2, 'erledigte Instanz plus Nachfolger');
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[1].status, 'open');
  assert.equal(rows[1].due_date, '2099-09-14', 'der Nachfolger steht eine Woche später');
});

test('POST: status=archived legt nicht ab, sondern fällt auf den ersten Status', async () => {
  // 'archived' ist seit #688 eine eigene Achse. PUT deutet den Wert für
  // Bestandsclients als „ablegen"; beim Anlegen gibt es nichts abzulegen, und
  // eine Aufgabe, die als Leiche zur Welt käme, wäre kein Anlegen.
  const r = await call('POST', '/', {
    as: { id: ALICE, role: 'admin' },
    body: { title: 'Direkt abgelegt?', status: 'archived' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, 'open');
  assert.equal(r.body.data.archived_at, null, 'und liegt nicht in der Ablage');
});

test('POST: ein leerer Status ist kein Status, sondern keiner (Review zu #807)', async () => {
  // `v.oneOf` behandelt undefined, null und '' gleich - alle drei heissen "nicht
  // angegeben" und kommen ohne Fehler durch den Validator. Die erste Fassung des
  // Defaults sah nur `undefined`, also trug ein leeres Auswahlfeld den Wert bis
  // ins INSERT: gegen eine NOT-NULL-Spalte mit CHECK, also 500 auf eine Eingabe,
  // die der eigene Validator eben noch akzeptiert hat.
  for (const leer of [null, '']) {
    const r = await call('POST', '/', {
      as: { id: ALICE, role: 'admin' },
      body: { title: `leerer-status-${JSON.stringify(leer)}`, status: leer },
    });
    assert.equal(r.status, 201, `status: ${JSON.stringify(leer)} darf kein Fehler sein`);
    assert.equal(r.body.data.status, 'open', 'und faellt auf den ersten Status');
    assert.equal(r.body.data.archived_at, null);
  }
});

test('POST: das eingegebene Faelligkeitsdatum bleibt stehen (#960)', async () => {
  // Der Server hat es einmal auf das erste Vorkommen der Regel gezogen, damit
  // das DTSTART im CalDAV-Push eindeutig ist. Das ist zurueckgenommen:
  // `due_date` haengt an Vorlauf, Erinnerung und Folgeinstanz, und keine dieser
  // Stellen erfaehrt von einer Verschiebung, die erst in der Route passiert -
  // der Client hat seine Erinnerung da laengst auf dem alten Tag gerechnet.
  const admin = { id: ALICE, role: 'admin' };
  const r = await call('POST', '/', {
    as: admin,
    body: {
      title: 'Zaehlerstand ablesen', start_date: '2026-01-10', due_date: '2026-01-15',
      is_recurring: 1, recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.due_date, '2026-01-15', 'die Faelligkeit bleibt, wie eingegeben');
  assert.equal(r.body.data.start_date, '2026-01-10', 'und der Vorlauf mit ihr');
});

test('POST: eine Aufgabe, deren einziges Vorkommen sie selbst ist, wird angenommen', async () => {
  // GEGENSTUECK ZUM KALENDER, NICHT SEINE KOPIE. Dort weist der Server eine
  // Serie ohne Vorkommen ab, weil allein die Expansion sie zeigt. Bei Aufgaben
  // liest die Liste `due_date` direkt, und die Regel betrifft erst den
  // Nachfolger: eine Aufgabe am 15. mit "am Monatsletzten, endet am 20." ist
  // am 15. faellig und danach fertig - gueltig, nicht leer. Ein aus dem
  // Kalender uebernommener Guard wies genau die ab.
  const admin = { id: ALICE, role: 'admin' };
  const r = await call('POST', '/', {
    as: admin,
    body: {
      title: 'Einmal und fertig', due_date: '2026-01-15',
      is_recurring: 1, recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120',
    },
  });
  assert.equal(r.status, 201, `erwartet 201, bekommen ${r.status}`);
  assert.equal(r.body.data.due_date, '2026-01-15', 'faellig am eingetragenen Tag');
  // UND SIE IST AUCH ZU SEHEN. Das ist der Punkt: waere sie unsichtbar wie ein
  // leerer Kalendertermin, haette der Guard recht gehabt.
  const liste = await call('GET', '/', { as: admin });
  assert.ok(
    liste.body.data.some((t) => t.id === r.body.data.id),
    'die Aufgabe steht in der Liste'
  );
});

test('PUT: die Regel nachtraeglich ankreuzen verschiebt die Faelligkeit nicht (#960)', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const angelegt = await call('POST', '/', { as: admin, body: { title: 'Erst ohne Regel', due_date: '2026-01-15' } });
  assert.equal(angelegt.body.data.due_date, '2026-01-15');

  const bearbeitet = await call('PUT', `/${angelegt.body.data.id}`, {
    as: admin,
    body: { title: 'Erst ohne Regel', is_recurring: 1, recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1' },
  });
  assert.equal(bearbeitet.status, 200);
  assert.equal(bearbeitet.body.data.due_date, '2026-01-15', 'der Server aendert das Datum nicht');
});

test('PUT: eine Serie ohne Nachfolger bleibt bearbeitbar', async () => {
  // Eine Serie, die keinen Nachfolger mehr hervorbringt, ist kein kaputter
  // Datensatz: die Aufgabe selbst bleibt faellig und muss sich weiter
  // bearbeiten lassen. Ein aus dem Kalender uebernommener Guard sperrte diese
  // Zeile - und weil das Formular bei jedem Speichern alle Felder mitschickt,
  // traf es auch reine Titel-Edits.
  const admin = { id: ALICE, role: 'admin' };
  const angelegt = await call('POST', '/', { as: admin, body: { title: 'Leere Serie', due_date: '2026-01-15' } });
  const id = angelegt.body.data.id;
  // Am Guard vorbei in die Zeile schreiben, wie es der Sync tut.
  db.prepare('UPDATE tasks SET is_recurring = 1, recurrence_rule = ? WHERE id = ?')
    .run('FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120', id);

  const nurTitel = await call('PUT', `/${id}`, {
    as: admin,
    body: {
      title: 'Neuer Titel', due_date: '2026-01-15',
      is_recurring: 1, recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120',
    },
  });
  assert.equal(nurTitel.status, 200, `ein Titel-Edit darf nicht scheitern, bekommen ${nurTitel.status}`);
  assert.equal(nurTitel.body.data.title, 'Neuer Titel');

  // Und auch das Verkuerzen der Regel geht durch: die Aufgabe bleibt am 15.
  // faellig, nur ein Nachfolger entsteht nicht mehr.
  const verkuerzt = await call('PUT', `/${id}`, {
    as: admin,
    body: { title: 'Neuer Titel', is_recurring: 1, recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260118' },
  });
  assert.equal(verkuerzt.status, 200, `erwartet 200, bekommen ${verkuerzt.status}`);
  assert.equal(verkuerzt.body.data.due_date, '2026-01-15', 'die Faelligkeit bleibt stehen');
});

test('PUT: ein Titel-Edit laesst eine eingelesene Serie in Ruhe (#756)', async () => {
  const admin = { id: ALICE, role: 'admin' };
  const angelegt = await call('POST', '/', { as: admin, body: { title: 'Fremd', due_date: '2026-01-15' } });
  const id = angelegt.body.data.id;
  db.prepare('UPDATE tasks SET is_recurring = 1, recurrence_rule = ? WHERE id = ?')
    .run('FREQ=MONTHLY;BYMONTHDAY=-1', id);

  const nurTitel = await call('PUT', `/${id}`, { as: admin, body: { title: 'Neuer Titel' } });
  assert.equal(nurTitel.status, 200);
  assert.equal(nurTitel.body.data.due_date, '2026-01-15', 'die Faelligkeit darf sich nicht bewegen');
});

test('PUT: die Wiederholung laesst sich einschalten, auch ohne Nachfolger', async () => {
  // Eine Aufgabe kann eine Regel tragen, ohne dass `is_recurring` gesetzt ist.
  // Wird sie eingeschaltet und bringt die Regel keinen Nachfolger hervor, ist
  // das kein Fehler: die Aufgabe bleibt an ihrem Tag faellig und laeuft danach
  // aus. Genau diesen Fall wies der frühere Guard ab.
  const admin = { id: ALICE, role: 'admin' };
  const angelegt = await call('POST', '/', { as: admin, body: { title: 'Ruhende Regel', due_date: '2026-01-15' } });
  const id = angelegt.body.data.id;
  db.prepare('UPDATE tasks SET recurrence_rule = ? WHERE id = ?')
    .run('FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120', id);

  const ein = await call('PUT', `/${id}`, { as: admin, body: { is_recurring: 1 } });
  assert.equal(ein.status, 200, `das Einschalten ist erlaubt, bekommen ${ein.status}`);

  // Eine Regel MIT Vorkommen laesst sich dagegen einschalten.
  db.prepare('UPDATE tasks SET recurrence_rule = ? WHERE id = ?').run('FREQ=MONTHLY;BYMONTHDAY=-1', id);
  const ok = await call('PUT', `/${id}`, { as: admin, body: { is_recurring: 1 } });
  assert.equal(ok.status, 200, `erwartet 200, bekommen ${ok.status}`);
  assert.equal(ok.body.data.due_date, '2026-01-15', 'und das Datum bleibt stehen');
});
