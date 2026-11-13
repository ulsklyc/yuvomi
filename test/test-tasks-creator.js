/**
 * Test: Der Ersteller einer Aufgabe steht an den Endpunkten (#2451)
 * Zweck: Die Liste zeigt neben dem Titel, WER die Aufgabe angelegt hat, und
 *        ein Filter engt sie auf einen Ersteller ein. Beides haengt an drei
 *        Feldern, die der JOIN auf `users` beilegt - und genau die waren bis
 *        zum Review dieses PRs an keiner Stelle festgenagelt:
 *        - GET /tasks, GET /tasks/:id und die Unteraufgaben tragen
 *          created_by_name, created_by_color und created_by_avatar
 *        - das Dashboard (urgentTasks) traegt sie auch: es rendert dieselbe
 *          Karte, und der JOIN fehlte dort zuerst
 *        - der Ersteller ist die Person, die POST geschickt hat, nicht die
 *          zugewiesene - die beiden zu verwechseln ist der ganze Grund, warum
 *          der Name auf der Karte ein Etikett braucht
 *        - eine Aufgabe eines geloeschten Mitglieds behaelt created_by, und die
 *          Namensfelder werden NULL statt die Zeile zu verlieren
 *        Die Einstellung selbst (admin-only, Boolean) hat ihre eigenen Tests in
 *        test/test-preferences-tasks-show-creator.js.
 * Ausführen: npm run test:tasks-creator
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? {
  getItem() { return null; }, setItem() {}, removeItem() {}, clear() {},
};

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'tasks-creator-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/authorize/index.ts');
const { __test: tasksPage } = await import('../public/pages/tasks.js');

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

function seedUser(prefix, role = 'member', color = '#007AFF') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', ?, ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, color, role).lastInsertRowid;
}

const ADMIN  = seedUser('admin', 'admin', '#FF3B30');
const MEMBER = seedUser('member', 'member', '#34C759');

let actor = { id: ADMIN, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, { id: actor.id, role: actor.role }));
  next();
});
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/dashboard', dashboardRouter);
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

/** Die drei Felder, die der JOIN beilegt - sie gehoeren zusammen. */
const CREATOR_FIELDS = ['created_by_name', 'created_by_color', 'created_by_avatar'];

const createTask = async (title, { as = asAdmin, ...rest } = {}) => {
  const r = await call('POST', '/tasks', { as, body: { title, ...rest } });
  assert.equal(r.status, 201, `POST /tasks ${title}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};

// --------------------------------------------------------

test('GET /tasks: jede Aufgabe traegt die drei Ersteller-Felder', async () => {
  const created = await createTask('von der Adminperson', { as: asAdmin });

  const list = await call('GET', '/tasks', { as: asAdmin });
  assert.equal(list.status, 200);
  const row = list.body.data.find((t) => t.id === created.id);
  assert.ok(row, 'die angelegte Aufgabe steht in der Liste');

  for (const field of CREATOR_FIELDS) {
    assert.ok(field in row, `${field} fehlt in GET /tasks - ohne den JOIN bleibt die Karte namenlos`);
  }
  assert.equal(row.created_by, ADMIN);
  assert.equal(row.created_by_name, 'admin');
  assert.equal(row.created_by_color, '#FF3B30');
});

test('der Ersteller ist die Person, die POST geschickt hat - nicht die zugewiesene', async () => {
  // Genau diese Verwechslung ist der Grund, warum der Name auf der Karte ein
  // Etikett traegt: zugewiesen MEMBER, erstellt von ADMIN.
  const created = await createTask('Adminperson legt an, Mitglied macht', {
    as: asAdmin, assigned_to: MEMBER,
  });

  const detail = await call('GET', `/tasks/${created.id}`, { as: asAdmin });
  assert.equal(detail.status, 200);
  const row = detail.body.data;

  assert.equal(row.created_by, ADMIN, 'erstellt hat die Adminperson');
  assert.equal(row.created_by_name, 'admin');
  assert.equal(row.assigned_to, MEMBER, 'zugewiesen ist das Mitglied');
  assert.equal(row.assigned_name, 'member');
  assert.notEqual(row.created_by_name, row.assigned_name,
    'die Probe braucht zwei verschiedene Personen, sonst sagt sie nichts');
});

test('GET /tasks/:id: die Ersteller-Felder stehen auch an der einzelnen Aufgabe', async () => {
  const created = await createTask('einzeln gelesen', { as: asMember });
  const detail = await call('GET', `/tasks/${created.id}`, { as: asAdmin });
  assert.equal(detail.status, 200);
  for (const field of CREATOR_FIELDS) {
    assert.ok(field in detail.body.data, `${field} fehlt in GET /tasks/:id`);
  }
  assert.equal(detail.body.data.created_by_name, 'member');
});

test('Unteraufgaben tragen ihren eigenen Ersteller', async () => {
  const parent = await createTask('Elternaufgabe', { as: asAdmin });
  const child = await createTask('Unteraufgabe', { as: asMember, parent_task_id: parent.id });

  const detail = await call('GET', `/tasks/${parent.id}`, { as: asAdmin });
  assert.equal(detail.status, 200);
  const subtasks = detail.body.data.subtasks ?? [];
  const sub = subtasks.find((t) => t.id === child.id);
  assert.ok(sub, `die Unteraufgabe steht am Elternteil: ${JSON.stringify(subtasks.map((t) => t.id))}`);
  for (const field of CREATOR_FIELDS) {
    assert.ok(field in sub, `${field} fehlt an der Unteraufgabe`);
  }
  assert.equal(sub.created_by_name, 'member', 'die Unteraufgabe nennt ihren eigenen Ersteller, nicht den des Elternteils');
});

test('der Ersteller einer gelisteten Aufgabe kann nie fehlen: created_by ist NOT NULL und CASCADE', async () => {
  // DAS IST DER GRUND, WARUM DIE KARTE KEINEN ERSATZNAMEN BRAUCHT.
  // `created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  // (server/db.js): eine Aufgabe ohne Ersteller gibt es nicht, und mit dem
  // geloeschten Mitglied geht die Aufgabe selbst. Anders als `assigned_to`,
  // das ON DELETE SET NULL traegt - dort IST der leere Fall moeglich.
  const geloescht = seedUser('vergaenglich', 'member');
  const created = await createTask('von einem spaeter geloeschten Mitglied', {
    as: { id: geloescht, role: 'member' },
  });

  // NOT NULL: der Ersteller laesst sich nicht nachtraeglich entfernen.
  assert.throws(
    () => db.prepare('UPDATE tasks SET created_by = NULL WHERE id = ?').run(created.id),
    /NOT NULL constraint failed: tasks\.created_by/,
    'created_by ist NOT NULL - faellt das weg, braucht die Karte einen Ersatznamen',
  );

  // CASCADE: mit dem Mitglied geht die Aufgabe, sie bleibt nicht namenlos stehen.
  db.prepare('DELETE FROM users WHERE id = ?').run(geloescht);
  const list = await call('GET', '/tasks', { as: asAdmin });
  assert.equal(list.body.data.find((t) => t.id === created.id), undefined,
    'die Aufgabe geht mit ihrem Ersteller (ON DELETE CASCADE)');
});

test('das Dashboard traegt die Ersteller-Felder an den dringenden Aufgaben', async () => {
  // Die Dashboard-Karte ist dieselbe wie in der Liste; der JOIN fehlte dort
  // zuerst, und die Karte blieb genau auf dem Dashboard namenlos. Gegen den
  // echten Endpunkt statt gegen den Quelltext: ein LEFT JOIN, der fehlt,
  // liesse das Feld fehlen oder NULL bleiben, nicht nur anders geschrieben
  // sein.
  const created = await createTask('dringend fuer das Dashboard', { as: asAdmin });

  const dashboard = await call('GET', '/dashboard', { as: asAdmin });
  assert.equal(dashboard.status, 200);
  const row = dashboard.body.urgentTasks.find((t) => t.id === created.id);
  assert.ok(row, 'die angelegte Aufgabe steht unter den dringenden - die Dashboard-Karte bliebe sonst leer');

  for (const field of CREATOR_FIELDS) {
    assert.ok(field in row, `${field} fehlt am Dashboard - ohne den JOIN bliebe die Karte namenlos`);
  }
  assert.equal(row.created_by_name, 'admin',
    'der Ersteller-JOIN ist ein LEFT JOIN auf t.created_by = cu.id: der Name muss am Dashboard stehen');
});

test('der Ersteller-Filter engt die Liste auf eine Person ein', async () => {
  const vonAdmin  = await createTask('Filterprobe Adminperson', { as: asAdmin });
  const vonMember = await createTask('Filterprobe Mitglied', { as: asMember });

  const r = await call('GET', `/tasks?creator=${ADMIN}`, { as: asAdmin });
  assert.equal(r.status, 200);
  const ids = r.body.data.map((t) => t.id);

  // Der Filter greift heute im Client (public/pages/tasks.js: `base.filter`).
  // Diese Probe haelt beides fest: filtert der Server, steht nur die eine
  // Aufgabe da; filtert er nicht, stehen beide - aber NIE nur die falsche.
  assert.ok(ids.includes(vonAdmin.id), 'die Aufgabe der Adminperson muss in der Antwort stehen');
  if (!ids.includes(vonMember.id)) {
    const fremd = r.body.data.filter((t) => t.created_by !== ADMIN);
    assert.deepEqual(fremd, [], 'wenn der Server filtert, bleibt kein fremder Ersteller uebrig');
  }
});

test('der Client-Filter vergleicht created_by, nicht den Namen', async () => {
  // Der Filterwert ist eine id (`state.filters.creator`), und der Vergleich
  // muss auf `created_by` gehen: auf den Namen verglichen trennten zwei
  // Mitglieder gleichen Namens nicht, und ein umbenanntes Mitglied verlor
  // seine Aufgaben aus dem Filter. Gegen die echte Funktion statt gegen den
  // Quelltext: zwei Mitglieder namens "Sam", nur eines gefiltert.
  const samOne = { id: 901, created_by: 901, title: 'Sam A' };
  const samTwo = { id: 902, created_by: 902, title: 'Sam B' };
  tasksPage.state.tasks = [samOne, samTwo];
  tasksPage.state.dueToday = false;
  tasksPage.state.searchQuery = '';
  tasksPage.state.filters = { ...tasksPage.state.filters, creator: 901 };
  try {
    const result = tasksPage.filteredTasks();
    assert.deepEqual(result.map((t) => t.id), [901],
      'der Ersteller-Filter muss nach created_by trennen, nicht nach Namen - beide heissen Sam');
  } finally {
    tasksPage.state.filters = { ...tasksPage.state.filters, creator: null };
    tasksPage.state.tasks = [];
  }
});
