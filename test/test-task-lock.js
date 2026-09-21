/**
 * Modul: Aufgabe sperren (#830)
 * Zweck: Die Trennlinie zwischen DEFINITION und INTERAKTION an einer gesperrten
 *        Aufgabe - über den echten Router, weil genau das der Punkt ist: die
 *        Regel muss auf jedem Schreibweg greifen und nicht nur dort, wo das UI
 *        den Knopf ausblendet. Geprüft werden PUT (Vollupdate wie aus dem
 *        Dialog), PATCH /:id/status, PATCH /:id/archive, DELETE, die
 *        Dokument-Verknüpfung, die drei Tag-Sammelwege, die Sammel-Ablage
 *        POST /archive (#1250) und die Vererbung auf
 *        Unteraufgaben. Berechtigt sind Ersteller:in und Admins - bewusst nicht
 *        `family_role`.
 * Ausführen: npm run test:task-lock
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-lock-test-secret';

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

// PARENT legt an und sperrt, CHILD darf erledigen aber nicht umschreiben,
// SIBLING ist die dritte Person, der CHILD nichts zuschieben können soll,
// ADMIN kommt überall durch.
const PARENT  = seedUser('parent');
const CHILD   = seedUser('child');
const SIBLING = seedUser('sibling');
const ADMIN   = seedUser('admin', 'admin');

const asParent  = { id: PARENT,  role: 'member' };
const asChild   = { id: CHILD,   role: 'member' };
const asAdmin   = { id: ADMIN,   role: 'admin'  };

let actor = asParent;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  // cookieSession: eine Sitzung, die neben einem API-Token mitkommt - requireAuth
  // setzt authUserId/authRole dann aus dem Token, req.session bleibt die Sitzung.
  req.session = actor.cookieSession ?? { userId: actor.id, role: actor.role };
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

/** Eine gesperrte Aufgabe von PARENT, für alle sichtbar. */
async function lockedTask(title, extra = {}) {
  const r = await call('POST', '/', {
    as: asParent,
    body: { title, visibility: 'all', locked: true, ...extra },
  });
  assert.equal(r.status, 201);
  return r.body.data;
}

/**
 * Das Vollupdate, das der Bearbeiten-Dialog schickt: die ganze Aufgabe zurück,
 * mit genau einer Abweichung. Ohne diese Form prüft der Test die falsche Sache -
 * ein Rumpf mit nur einem Feld trifft den Vergleich nie dort, wo er wehtut.
 */
function fullUpdate(task, changes = {}) {
  return {
    title:           task.title,
    description:     task.description,
    category:        task.category,
    priority:        task.priority,
    status:          task.status,
    start_date:      task.start_date,
    due_date:        task.due_date,
    due_time:        task.due_time,
    points:          task.points,
    visibility:      task.visibility,
    is_recurring:    task.is_recurring,
    recurrence_rule: task.recurrence_rule,
    countdown:       task.countdown,
    ...changes,
  };
}

test('POST: locked wird gesetzt und ausgeliefert; ohne Angabe bleibt es 0', async () => {
  const locked = await lockedTask('Hausaufgaben');
  assert.equal(locked.locked, 1);
  const plain = await call('POST', '/', { as: asParent, body: { title: 'Offen', visibility: 'all' } });
  assert.equal(plain.body.data.locked, 0);
});

// --------------------------------------------------------
// Der Kern: dieselbe Aufgabe, dieselbe Person, zwei Absichten
// --------------------------------------------------------

test('PUT: eine fremde gesperrte Aufgabe lässt sich nicht umschreiben', async () => {
  const task = await lockedTask('Hausaufgaben vor dem Abendessen');
  const r = await call('PUT', `/${task.id}`, {
    as: asChild,
    body: fullUpdate(task, { title: 'Hausaufgaben wann ich will' }),
  });
  assert.equal(r.status, 403);
  const still = db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id);
  assert.equal(still.title, 'Hausaufgaben vor dem Abendessen');
});

test('PUT: dieselbe Person hakt dieselbe Aufgabe ab - mit dem vollen Rumpf des Dialogs', async () => {
  const task = await lockedTask('Müll rausbringen');
  const r = await call('PUT', `/${task.id}`, {
    as: asChild,
    body: fullUpdate(task, { status: 'done' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'done');
});

test('PATCH /:id/status: der kurze Weg zum Abhaken bleibt offen', async () => {
  const task = await lockedTask('Tisch decken');
  const r = await call('PATCH', `/${task.id}/status`, { as: asChild, body: { status: 'in_progress' } });
  assert.equal(r.status, 200);
});

test('PUT: Ersteller:in und Admin kommen durch', async () => {
  const task = await lockedTask('Zimmer aufräumen');
  const byCreator = await call('PUT', `/${task.id}`, {
    as: asParent, body: fullUpdate(task, { title: 'Zimmer aufräumen, auch unter dem Bett' }),
  });
  assert.equal(byCreator.status, 200);

  const byAdmin = await call('PUT', `/${task.id}`, {
    as: asAdmin, body: fullUpdate(task, { title: 'Zimmer aufräumen (Admin)' }),
  });
  assert.equal(byAdmin.status, 200);
});

test('PUT: ein Mitglieds-Token neben einer Admin-Sitzung schreibt nicht um, die Admin-Sitzung allein schon', async () => {
  const task = await lockedTask('Blumen gießen');
  const withToken = await call('PUT', `/${task.id}`, {
    as: { ...asChild, cookieSession: { userId: ADMIN, role: 'admin' } },
    body: fullUpdate(task, { title: 'Blumen gießen, wenn mir danach ist' }),
  });
  assert.equal(withToken.status, 403, 'die Sperre urteilt nach der Rolle des Token-Subjekts');
  assert.equal(db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id).title, 'Blumen gießen');

  const adminOnly = await call('PUT', `/${task.id}`, {
    as: asAdmin, body: fullUpdate(task, { title: 'Blumen gießen (Admin)' }),
  });
  assert.equal(adminOnly.status, 200);
});

test('PUT: die Sperre selbst zu lösen ist der erste Zug - und er ist zu', async () => {
  const task = await lockedTask('Vokabeln lernen');
  const r = await call('PUT', `/${task.id}`, { as: asChild, body: fullUpdate(task, { locked: false }) });
  assert.equal(r.status, 403);
  assert.equal(db.prepare('SELECT locked FROM tasks WHERE id = ?').get(task.id).locked, 1);

  const byCreator = await call('PUT', `/${task.id}`, { as: asParent, body: fullUpdate(task, { locked: false }) });
  assert.equal(byCreator.status, 200);
  assert.equal(byCreator.body.data.locked, 0);
});

test('PUT: nicht mitgeschicktes locked lässt die Sperre stehen', async () => {
  const task = await lockedTask('Rasen mähen');
  const r = await call('PUT', `/${task.id}`, { as: asParent, body: { title: 'Rasen mähen' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.locked, 1);
});

// --------------------------------------------------------
// Zuweisung: die eigene ist Interaktion, die fremde ist Definition
// --------------------------------------------------------

test('PUT: sich selbst eintragen darf, wer die Aufgabe nehmen will', async () => {
  const task = await lockedTask('Spülmaschine ausräumen');
  const r = await call('PUT', `/${task.id}`, {
    as: asChild, body: fullUpdate(task, { assigned_to: [CHILD] }),
  });
  assert.equal(r.status, 200);
  const rows = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(task.id);
  assert.deepEqual(rows.map((x) => x.user_id), [CHILD]);
});

test('PUT: sich selbst wieder austragen geht genauso', async () => {
  const task = await lockedTask('Katze füttern', { assigned_to: [CHILD] });
  const r = await call('PUT', `/${task.id}`, { as: asChild, body: fullUpdate(task, { assigned_to: [] }) });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM task_assignments WHERE task_id = ?').get(task.id).c, 0);
});

test('PUT: die Aufgabe einem Dritten zuschieben ist eine Definitionsänderung', async () => {
  const task = await lockedTask('Einkaufen gehen');
  const r = await call('PUT', `/${task.id}`, {
    as: asChild, body: fullUpdate(task, { assigned_to: [SIBLING] }),
  });
  assert.equal(r.status, 403);
});

test('PUT: eine fremde Zuweisung stehen lassen und sich danebenstellen ist erlaubt', async () => {
  const task = await lockedTask('Tisch abräumen', { assigned_to: [SIBLING] });
  const r = await call('PUT', `/${task.id}`, {
    as: asChild, body: fullUpdate(task, { assigned_to: [SIBLING, CHILD] }),
  });
  assert.equal(r.status, 200);
});

test('PUT: eine fremde Zuweisung entfernen ist zu', async () => {
  const task = await lockedTask('Wäsche aufhängen', { assigned_to: [SIBLING] });
  const r = await call('PUT', `/${task.id}`, { as: asChild, body: fullUpdate(task, { assigned_to: [CHILD] }) });
  assert.equal(r.status, 403);
});

// --------------------------------------------------------
// Die anderen Schreibwege auf dieselbe Aufgabe
// --------------------------------------------------------

test('DELETE: gesperrt für Fremde, offen für Ersteller:in', async () => {
  const task = await lockedTask('Fahrrad putzen');
  assert.equal((await call('DELETE', `/${task.id}`, { as: asChild })).status, 403);
  assert.equal((await call('DELETE', `/${task.id}`, { as: asParent })).status, 200);
});

test('PATCH /:id/archive: ablegen nimmt sie allen aus der Ansicht - also gesperrt', async () => {
  const task = await lockedTask('Zeugnis unterschreiben lassen');
  assert.equal((await call('PATCH', `/${task.id}/archive`, { as: asChild, body: { archived: true } })).status, 403);
  assert.equal((await call('PATCH', `/${task.id}/archive`, { as: asAdmin, body: { archived: true } })).status, 200);
});

test('PATCH /:id/archive: prüft seit #830 auch die Sichtbarkeit (Muster #769)', async () => {
  const priv = await call('POST', '/', { as: asParent, body: { title: 'Privat', visibility: 'private' } });
  const r = await call('PATCH', `/${priv.body.data.id}/archive`, { as: asChild, body: { archived: true } });
  assert.equal(r.status, 404, 'eine geratene id darf keine fremde private Aufgabe ablegen');
});

test('PUT /:id/documents: angehängte Unterlagen gehören zur Anweisung', async () => {
  const task = await lockedTask('Antrag ausfüllen');
  const docId = db.prepare(`
    INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, created_by)
    VALUES ('Formular', 'formular.pdf', 'application/pdf', 10, ?, 'other', 'family', 'active', ?)
  `).run(Buffer.from('bytes'), PARENT).lastInsertRowid;
  assert.equal((await call('PUT', `/${task.id}/documents`, { as: asChild, body: { document_ids: [docId] } })).status, 403);
  assert.equal((await call('PUT', `/${task.id}/documents`, { as: asParent, body: { document_ids: [docId] } })).status, 200);
});

// --------------------------------------------------------
// Vererbung: eine Unteraufgabe ist Teil derselben Anweisung
// --------------------------------------------------------

test('Unteraufgaben: die Sperre der Elternaufgabe gilt eine Ebene tiefer', async () => {
  const parent = await lockedTask('Schulranzen packen');
  const sub = await call('POST', '/', {
    as: asParent, body: { title: 'Sportsachen', parent_task_id: parent.id, visibility: 'all' },
  });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.data.locked, 0, 'die Unteraufgabe trägt kein eigenes Flag');

  const rename = await call('PUT', `/${sub.body.data.id}`, {
    as: asChild, body: fullUpdate(sub.body.data, { title: 'Sportsachen (egal)' }),
  });
  assert.equal(rename.status, 403, 'geerbt, nicht am eigenen Flag abgelesen');

  const tick = await call('PATCH', `/${sub.body.data.id}/status`, { as: asChild, body: { status: 'done' } });
  assert.equal(tick.status, 200, 'abhaken bleibt auch eine Ebene tiefer offen');
});

test('POST: einen Punkt an eine gesperrte Checkliste hängen ist zu', async () => {
  const parent = await lockedTask('Wochenplan');
  const r = await call('POST', '/', {
    as: asChild, body: { title: 'Und Eis essen', parent_task_id: parent.id },
  });
  assert.equal(r.status, 403);
  const byCreator = await call('POST', '/', {
    as: asParent, body: { title: 'Und Zimmer wischen', parent_task_id: parent.id },
  });
  assert.equal(byCreator.status, 201);
});

// --------------------------------------------------------
// Sammelwege: überspringen statt abweisen, und es sagen
// --------------------------------------------------------

test('POST /tags/apply: gesperrte Aufgaben fallen aus der Auswahl und werden gezählt', async () => {
  const locked = await lockedTask('Gesperrt mit Tag');
  const open   = await call('POST', '/', { as: asParent, body: { title: 'Offen mit Tag', visibility: 'all' } });
  const r = await call('POST', '/tags/apply', {
    as: asChild, body: { ids: [locked.id, open.body.data.id], add: ['schule'] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.updated, 1);
  assert.equal(r.body.data.skipped, 1, 'die Teilausführung muss in der Antwort stehen');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM task_tags WHERE task_id = ?').get(locked.id).c, 0);
});

test('PUT /tags/:tag: an einer gesperrten Aufgabe hält sich der alte Name', async () => {
  const locked = await call('POST', '/', {
    as: asParent, body: { title: 'Gesperrt, getaggt', visibility: 'all', locked: true, tags: ['garten'] },
  });
  const open = await call('POST', '/', {
    as: asChild, body: { title: 'Offen, getaggt', visibility: 'all', tags: ['garten'] },
  });
  const r = await call('PUT', '/tags/garten', { as: asChild, body: { name: 'hof' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.updated, 1);
  assert.equal(r.body.data.skipped, 1);

  const tagOf = (id) => db.prepare('SELECT tag FROM task_tags WHERE task_id = ?').all(id).map((x) => x.tag);
  assert.deepEqual(tagOf(locked.body.data.id), ['garten']);
  assert.deepEqual(tagOf(open.body.data.id), ['hof']);
});

test('DELETE /tags/:tag: der Tag bleibt an der gesperrten Aufgabe hängen', async () => {
  const locked = await call('POST', '/', {
    as: asParent, body: { title: 'Gesperrt, Ferien', visibility: 'all', locked: true, tags: ['ferien'] },
  });
  const open = await call('POST', '/', {
    as: asChild, body: { title: 'Offen, Ferien', visibility: 'all', tags: ['ferien'] },
  });
  const r = await call('DELETE', '/tags/ferien', { as: asChild });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.updated, 1);
  assert.equal(r.body.data.skipped, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM task_tags WHERE task_id = ?').get(locked.body.data.id).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM task_tags WHERE task_id = ?').get(open.body.data.id).c, 0);
});

// --------------------------------------------------------
// Sammel-Ablage (#1250): dieselben Regeln wie PATCH /:id/archive, je ID
// --------------------------------------------------------

const archivedAt = (id) => db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id).archived_at;

test('POST /archive: legt eine Auswahl in einem Aufruf ab und lässt den Status stehen', async () => {
  const a = await call('POST', '/', { as: asParent, body: { title: 'Sammel A', visibility: 'all', status: 'done' } });
  const b = await call('POST', '/', { as: asParent, body: { title: 'Sammel B', visibility: 'all', status: 'done' } });
  const r = await call('POST', '/archive', { as: asChild, body: { ids: [a.body.data.id, b.body.data.id] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { archived: 2, skipped: 0 });
  for (const t of [a, b]) {
    assert.ok(archivedAt(t.body.data.id), 'archived_at wird gesetzt');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(t.body.data.id).status, 'done');
  }
});

test('POST /archive: gesperrte Aufgaben werden übersprungen und gezählt, der Rest geht durch', async () => {
  const locked = await lockedTask('Gesperrt, erledigt', { status: 'done' });
  const open   = await call('POST', '/', { as: asParent, body: { title: 'Frei, erledigt', visibility: 'all', status: 'done' } });
  const r = await call('POST', '/archive', { as: asChild, body: { ids: [locked.id, open.body.data.id] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.archived, 1);
  assert.equal(r.body.data.skipped, 1, 'die Teilausführung muss in der Antwort stehen');
  assert.equal(archivedAt(locked.id), null);
  assert.ok(archivedAt(open.body.data.id));

  // Ersteller:in und Admin kommen durch - wie beim Einzelweg.
  const byAdmin = await call('POST', '/archive', { as: asAdmin, body: { ids: [locked.id] } });
  assert.deepEqual(byAdmin.body.data, { archived: 1, skipped: 0 });
});

test('POST /archive: eine Unteraufgabe erbt die Sperre ihrer Elternaufgabe', async () => {
  const parent = await lockedTask('Gesperrte Eltern');
  const sub = (await call('POST', '/', { as: asParent, body: { title: 'Punkt', parent_task_id: parent.id } })).body.data;
  const r = await call('POST', '/archive', { as: asChild, body: { ids: [sub.id] } });
  assert.deepEqual(r.body.data, { archived: 0, skipped: 1 });
  assert.equal(archivedAt(sub.id), null);
});

test('POST /archive: eine fremde private Aufgabe fällt still heraus', async () => {
  const priv = await call('POST', '/', { as: asParent, body: { title: 'Privat', visibility: 'private', status: 'done' } });
  const mine = await call('POST', '/', { as: asChild, body: { title: 'Meine', visibility: 'all', status: 'done' } });
  const r = await call('POST', '/archive', { as: asChild, body: { ids: [priv.body.data.id, mine.body.data.id, 99999999] } });
  assert.equal(r.status, 200);
  // Weder abgelegt noch als "gesperrt" gezaehlt: beides waere eine Auskunft
  // darueber, dass es die Aufgabe gibt.
  assert.deepEqual(r.body.data, { archived: 1, skipped: 0 });
  assert.equal(archivedAt(priv.body.data.id), null);
});

test('POST /archive: schon Abgelegtes behält den Zeitpunkt des ersten Ablegens', async () => {
  const t = await call('POST', '/', { as: asParent, body: { title: 'Längst abgelegt', visibility: 'all' } });
  db.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', t.body.data.id);
  const r = await call('POST', '/archive', { as: asParent, body: { ids: [t.body.data.id] } });
  assert.deepEqual(r.body.data, { archived: 0, skipped: 0 });
  assert.equal(archivedAt(t.body.data.id), '2020-01-01T00:00:00Z');
});

test('POST /archive: ohne ids 400, über 500 IDs 400 und nichts abgelegt', async () => {
  assert.equal((await call('POST', '/archive', { as: asParent, body: {} })).status, 400);
  assert.equal((await call('POST', '/archive', { as: asParent, body: { ids: [] } })).status, 400);
  const t = await call('POST', '/', { as: asParent, body: { title: 'Nicht über die Grenze', visibility: 'all' } });
  const tooMany = [t.body.data.id, ...Array.from({ length: 500 }, (_, i) => 10_000_000 + i)];
  const r = await call('POST', '/archive', { as: asParent, body: { ids: tooMany } });
  assert.equal(r.status, 400);
  assert.equal(archivedAt(t.body.data.id), null, 'eine abgewiesene Anfrage legt auch nichts teilweise ab');
  // Genau 500 geht noch durch.
  const ok = await call('POST', '/archive', { as: asParent, body: { ids: tooMany.slice(0, 500) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.archived, 1);
});

// --------------------------------------------------------
// Gegenprobe: ohne Sperre ändert sich nichts
// --------------------------------------------------------

test('Bestand: eine ungesperrte Aufgabe bleibt für alle voll bearbeitbar', async () => {
  const task = await call('POST', '/', { as: asParent, body: { title: 'Ganz normal', visibility: 'all' } });
  const edit = await call('PUT', `/${task.body.data.id}`, {
    as: asChild, body: fullUpdate(task.body.data, { title: 'Ganz normal, geändert' }),
  });
  assert.equal(edit.status, 200);
  assert.equal((await call('DELETE', `/${task.body.data.id}`, { as: asChild })).status, 200);
});

test('Bestand: wer eine offene Aufgabe sperrt, sperrt sich selbst nicht aus, wenn er sie angelegt hat', async () => {
  const task = await call('POST', '/', { as: asChild, body: { title: 'Meine eigene', visibility: 'all' } });
  const lock = await call('PUT', `/${task.body.data.id}`, {
    as: asChild, body: fullUpdate(task.body.data, { locked: true }),
  });
  assert.equal(lock.status, 200);
  assert.equal(lock.body.data.locked, 1);
  const again = await call('PUT', `/${task.body.data.id}`, {
    as: asChild, body: fullUpdate(lock.body.data, { title: 'Meine eigene, umbenannt' }),
  });
  assert.equal(again.status, 200);
});
