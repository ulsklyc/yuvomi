/**
 * Modul: Vorheraufgaben (blockierende Voraussetzungen)
 * Zweck: Die Klammer um die neue Beziehung - Abhaken blockiert, bis die
 *        Vorheraufgabe erledigt ist (PATCH und PUT, auch fürs Wandtablet),
 *        Zyklus und Selbstbezug beim Setzen abgewiesen, Geloeschtes faellt
 *        weg, die Folgeinstanz einer Serie erbt die Bedingungen.
 * Ausführen: npm run test:task-prerequisites
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-prereq-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const moduleDatabase = get();
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
for (const m of MIGRATIONS) {
  if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
  if (typeof m.afterUp === 'function') m.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
}
_setTestDatabase(db);
moduleDatabase.close();

const admin = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('mom', 'Mama', 'x', 'admin')").run().lastInsertRowid;
const kid = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('diana', 'Diana', 'x', 'member')").run().lastInsertRowid;

const app = express();
app.use(express.json());
let actor = { id: admin, role: 'admin' };
app.use((req, res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/tasks`;

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
const ADMIN = { id: admin, role: 'admin' };
const task = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const prereqRows = (id) => db
  .prepare('SELECT prerequisite_task_id FROM task_prerequisites WHERE task_id = ? ORDER BY prerequisite_task_id')
  .all(id).map((r) => r.prerequisite_task_id);
const mk = async (body, as = ADMIN) => {
  const r = await call('POST', '/', { as, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
};

// ----------------------------------------------------------
// Schema und Setzen
// ----------------------------------------------------------
test('Migration 272: Tabelle vorhanden', () => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'task_prerequisites'").get();
  assert.ok(row);
});

let waschen, einraeumen;
test('POST mit prerequisites: Detailantwort nennt sie', async () => {
  waschen = await mk({ title: 'Seitenteile waschen' });
  einraeumen = await mk({ title: 'Pavillon einraeumen', prerequisites: [waschen] });
  const d = await call('GET', `/${einraeumen}`, { as: ADMIN });
  assert.equal(d.status, 200);
  assert.equal(d.body.data.prerequisites.length, 1);
  assert.equal(d.body.data.prerequisites[0].id, waschen);
  assert.equal(d.body.data.prerequisites[0].done, false);
});

test('Selbstbezug -> 400 task_prerequisite_self', async () => {
  const r = await call('POST', '/', { as: ADMIN, body: { title: 'Sich selbst', prerequisites: [] } });
  const id = r.body.data.id;
  const b = await call('PUT', `/${id}`, { as: ADMIN, body: { title: 'Sich selbst', prerequisites: [id] } });
  assert.equal(b.status, 400);
  assert.equal(b.body.reason, 'task_prerequisite_self');
});

test('Unbekannte Vorheraufgabe -> 400 task_prerequisite_not_found', async () => {
  const b = await call('PUT', `/${einraeumen}`, { as: ADMIN, body: { title: 'Pavillon einraeumen', prerequisites: [999999] } });
  assert.equal(b.status, 400);
  assert.equal(b.body.reason, 'task_prerequisite_not_found');
});

test('Zyklus -> 400 task_prerequisite_cycle (Kante schliesst den Kreis)', async () => {
  const b = await call('PUT', `/${waschen}`, { as: ADMIN, body: { title: 'Seitenteile waschen', prerequisites: [einraeumen] } });
  assert.equal(b.status, 400);
  assert.equal(b.body.reason, 'task_prerequisite_cycle');
  assert.deepEqual(prereqRows(waschen), []); // kein halber Stand
});

// ----------------------------------------------------------
// Blockieren beim Abhaken
// ----------------------------------------------------------
test('Offene Vorheraufgabe blockiert PATCH done (409 mit Liste)', async () => {
  const r = await call('PATCH', `/${einraeumen}/status`, { as: { id: kid, role: 'member' }, body: { status: 'done' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'tasks_prerequisite_open');
  assert.equal(r.body.open_prerequisites.length, 1);
  assert.equal(r.body.open_prerequisites[0].title, 'Seitenteile waschen');
  assert.equal(task(einraeumen).status, 'open');
});

test('Derselbe Fall blockiert PUT done', async () => {
  const b = await call('PUT', `/${einraeumen}`, { as: ADMIN, body: { title: 'Pavillon einraeumen', status: 'done' } });
  assert.equal(b.status, 409);
  assert.equal(b.body.reason, 'tasks_prerequisite_open');
});

test('Vorheraufgabe erledigt -> abhakbar; PUT ersetzt die Liste', async () => {
  const other = await mk({ title: 'Sonne runter' });
  const w = await call('PATCH', `/${waschen}/status`, { as: ADMIN, body: { status: 'done' } });
  assert.equal(w.status, 200);
  const r = await call('PATCH', `/${einraeumen}/status`, { as: ADMIN, body: { status: 'done' } });
  assert.equal(r.status, 200);
  // Liste ersetzen: neue offene Bedingung macht wieder dicht.
  const p = await call('PUT', `/${einraeumen}`, { as: ADMIN, body: { title: 'Pavillon einraeumen', prerequisites: [other] } });
  assert.equal(p.status, 200);
  assert.deepEqual(prereqRows(einraeumen), [other]);
});

test('Zuruecknehmen einer erledigten Vorheraufgabe oeffnet nichts, blockiert aber erneut', async () => {
  const set = await call('PUT', `/${einraeumen}`, { as: ADMIN, body: { title: 'Pavillon einraeumen', prerequisites: [waschen] } });
  assert.equal(set.status, 200);
  const again = await call('PATCH', `/${einraeumen}/status`, { as: ADMIN, body: { status: 'open' } });
  assert.equal(again.status, 200);
  const u = await call('PATCH', `/${waschen}/status`, { as: ADMIN, body: { status: 'open' } });
  assert.equal(u.status, 200); // Vorhersage zurueck - kein Kaskade
  const r = await call('PATCH', `/${einraeumen}/status`, { as: ADMIN, body: { status: 'done' } });
  assert.equal(r.status, 409); // war durch, ist wieder dicht
});

// ----------------------------------------------------------
// Liste, Loeschen, Serie
// ----------------------------------------------------------
test('Liste liefert open_prerequisite_count', async () => {
  const l = await call('GET', '/', { as: ADMIN });
  assert.equal(l.status, 200);
  const row = l.body.data.find((t) => t.id === einraeumen);
  assert.equal(row.open_prerequisite_count, 1);
});

test('Geloeschte Vorheraufgabe blockiert nicht mehr (CASCADE)', async () => {
  const del = await call('DELETE', `/${prereqRows(einraeumen)[0]}`, { as: ADMIN });
  assert.equal(del.status, 200);
  assert.deepEqual(prereqRows(einraeumen), []);
  const r = await call('PATCH', `/${einraeumen}/status`, { as: ADMIN, body: { status: 'done' } });
  assert.equal(r.status, 200);
});

test('Folgeinstanz einer Serie erbt die Vorheraufgaben', async () => {
  const prereq = await mk({ title: 'Zaehne zaehlen' });
  const weekly = await mk({
    title: 'Wochenaufgabe mit Bedingung',
    is_recurring: true,
    recurrence_rule: 'FREQ=WEEKLY',
    due_date: '2026-10-01',
    prerequisites: [prereq],
  });
  const p = await call('PATCH', `/${prereq}/status`, { as: ADMIN, body: { status: 'done' } });
  assert.equal(p.status, 200);
  const d = await call('PATCH', `/${weekly}/status`, { as: ADMIN, body: { status: 'done' } });
  assert.equal(d.status, 200);
  const followup = db.prepare('SELECT id FROM tasks WHERE recurrence_origin_id = ? AND parent_task_id IS NULL').get(weekly);
  assert.ok(followup, 'Folgeinstanz angelegt');
  assert.deepEqual(prereqRows(followup.id), [prereq]);
});

test.after(() => { server.close(); db.close(); });
