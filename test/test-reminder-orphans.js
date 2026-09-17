/**
 * Modul: Verwaiste Erinnerungen (Migration v217)
 * Zweck: `reminders.entity_type`/`entity_id` sind ein WEICHER Verweis - die
 *        einzige Fremdschluesselspalte der Tabelle ist `created_by`. Abgeraeumt
 *        hat die Erinnerung einer geloeschten Aufgabe bis v217 allein der
 *        Client, mit stummem `catch` und nur fuer die eigenen Zeilen. Diese
 *        Suite haelt die drei Stufen fest, die das ersetzt haben:
 *          1. die beiden AFTER-DELETE-Trigger auf `tasks`/`calendar_events`,
 *             und zwar an der VOLLEN Migrationskette - ein kuenftiger
 *             Tabellen-Rebuild, der sie nicht wieder anlegt (wie es v114/v117
 *             und v166/v194 fuer `trg_search_*_ad` tun muessen), faellt hier auf;
 *          2. das einmalige Abraeumen der Bestands-Waisen in v217 selbst;
 *          3. die beiden Lese-Riegel (GET /reminders/pending und
 *             processDueNotifications), die eine trotzdem entstandene Waise
 *             nicht mehr als leere Meldung ausliefern.
 *
 * Netz-frei: nur In-Memory-SQLite, Provider und Push-Dienst sind Attrappen.
 * Ausführen: node --test test/test-reminder-orphans.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');

// --------------------------------------------------------
// Test-DB via vollständige Migrationskette (Form aus test-reminders-routes.js).
// `upTo` baut bewusst einen ÄLTEREN Stand: nur so lässt sich eine Waise
// erzeugen, die es nach v217 gar nicht mehr geben kann.
// --------------------------------------------------------
function buildTestDb({ upTo = Infinity } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (m.version > upTo) break;
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

let userSeq = 0;
function freshUser(database = db) {
  userSeq += 1;
  return database.prepare(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, '$2b$12$x', 'member')`,
  ).run(`orphan-u${userSeq}`, `User ${userSeq}`).lastInsertRowid;
}

function makeTask(database, owner, { parent = null, title = 'Steuer' } = {}) {
  return database.prepare(
    `INSERT INTO tasks (title, category, status, created_by, parent_task_id) VALUES (?, 'Sonstiges', 'open', ?, ?)`,
  ).run(title, owner, parent).lastInsertRowid;
}

function makeEvent(database, owner, { parent = null, title = 'Zahnarzt' } = {}) {
  return database.prepare(
    `INSERT INTO calendar_events (title, start_datetime, created_by, recurrence_parent_id, recurrence_id)
     VALUES (?, '2026-05-01T10:00', ?, ?, ?)`,
  ).run(title, owner, parent, parent === null ? null : '2026-05-08T10:00').lastInsertRowid;
}

function insertReminder(database, owner, entityType, entityId, remindAt = PAST) {
  return database.prepare(
    `INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?)`,
  ).run(entityType, entityId, remindAt, owner).lastInsertRowid;
}

function reminderCount(database, entityType, entityId) {
  return database.prepare(
    'SELECT COUNT(*) AS c FROM reminders WHERE entity_type = ? AND entity_id = ?',
  ).get(entityType, entityId).c;
}

const PAST = '2000-01-01T00:00:00';  // immer <= jetzt -> fällig

// --------------------------------------------------------
// 1. Die Trigger, an der vollen Kette
// --------------------------------------------------------

test('eine geloeschte Aufgabe nimmt ihre Erinnerungen mit - auch die fremder Mitglieder', () => {
  const owner = freshUser();
  const other = freshUser();
  const taskId = makeTask(db, owner);

  insertReminder(db, owner, 'task', taskId);
  // GENAU DIE ZEILE, die der Client nie erreichen konnte: sein
  // `DELETE /reminders?entity_type=task&...` filtert auf `created_by`.
  insertReminder(db, other, 'task', taskId);
  assert.equal(reminderCount(db, 'task', taskId), 2);

  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

  assert.equal(reminderCount(db, 'task', taskId), 0);
});

test('eine per CASCADE mitgeloeschte Unteraufgabe nimmt ihre Erinnerung ebenfalls mit', () => {
  const owner = freshUser();
  const parentId = makeTask(db, owner, { title: 'Umzug' });
  const childId = makeTask(db, owner, { parent: parentId, title: 'Kisten packen' });

  insertReminder(db, owner, 'task', parentId);
  insertReminder(db, owner, 'task', childId);

  // Gelöscht wird NUR die Elternaufgabe; die Unteraufgabe geht per
  // `parent_task_id ... ON DELETE CASCADE`. Dass ein AFTER-DELETE-Trigger auch
  // für so eine Zeile feuert, ist die Annahme, auf der die ganze Stufe ruht.
  db.prepare('DELETE FROM tasks WHERE id = ?').run(parentId);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE id = ?').get(childId).c, 0);
  assert.equal(reminderCount(db, 'task', parentId), 0);
  assert.equal(reminderCount(db, 'task', childId), 0);
});

test('ein geloeschter Termin nimmt seine Erinnerungen mit, samt Ausnahme-Instanz', () => {
  const owner = freshUser();
  const other = freshUser();
  const masterId = makeEvent(db, owner, { title: 'Yoga' });
  const childId = makeEvent(db, owner, { parent: masterId, title: 'Yoga (verschoben)' });

  insertReminder(db, owner, 'event', masterId);
  insertReminder(db, other, 'event', masterId);
  insertReminder(db, owner, 'event', childId);

  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(masterId);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM calendar_events WHERE id = ?').get(childId).c, 0);
  assert.equal(reminderCount(db, 'event', masterId), 0);
  assert.equal(reminderCount(db, 'event', childId), 0);
});

test('die Erinnerung einer NICHT geloeschten Aufgabe bleibt stehen', () => {
  const owner = freshUser();
  const doomed = makeTask(db, owner, { title: 'Weg' });
  const keeper = makeTask(db, owner, { title: 'Bleibt' });
  insertReminder(db, owner, 'task', doomed);
  insertReminder(db, owner, 'task', keeper);

  db.prepare('DELETE FROM tasks WHERE id = ?').run(doomed);

  assert.equal(reminderCount(db, 'task', doomed), 0);
  assert.equal(reminderCount(db, 'task', keeper), 1);
});

test('beide Trigger stehen auf der voll migrierten Datenbank', () => {
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_reminders_%'",
  ).all().map((r) => r.name).sort();
  assert.deepEqual(names, ['trg_reminders_events_ad', 'trg_reminders_tasks_ad']);
});

// --------------------------------------------------------
// 2. Das einmalige Abräumen in v217 selbst
// --------------------------------------------------------

test('v217 raeumt die Waisen ab, die vor ihr entstanden sind', () => {
  // Stand VOR v217: die Trigger gibt es noch nicht, eine gelöschte Aufgabe
  // lässt ihre Erinnerung also wirklich stehen - so ist der Bestand entstanden,
  // den die Migration vorfindet.
  const old = buildTestDb({ upTo: 216 });
  const owner = freshUser(old);

  const goneTask = makeTask(old, owner, { title: 'Geloescht' });
  const liveTask = makeTask(old, owner, { title: 'Da' });
  const goneEvent = makeEvent(old, owner, { title: 'Geloescht' });
  const liveEvent = makeEvent(old, owner, { title: 'Da' });

  insertReminder(old, owner, 'task', goneTask);
  insertReminder(old, owner, 'task', liveTask);
  insertReminder(old, owner, 'event', goneEvent);
  insertReminder(old, owner, 'event', liveEvent);

  old.prepare('DELETE FROM tasks WHERE id = ?').run(goneTask);
  old.prepare('DELETE FROM calendar_events WHERE id = ?').run(goneEvent);
  // Ohne die Migration steht die Waise noch - das ist der Befund, nicht bloß die
  // Vorbedingung.
  assert.equal(reminderCount(old, 'task', goneTask), 1);
  assert.equal(reminderCount(old, 'event', goneEvent), 1);

  const v217 = MIGRATIONS.find((m) => m.version === 217);
  assert.ok(v217, 'Migration v217 fehlt');
  old.exec(v217.up);

  assert.equal(reminderCount(old, 'task', goneTask), 0);
  assert.equal(reminderCount(old, 'event', goneEvent), 0);
  assert.equal(reminderCount(old, 'task', liveTask), 1);
  assert.equal(reminderCount(old, 'event', liveEvent), 1);
  old.close();
});

// --------------------------------------------------------
// 3. Die Lese-Riegel
// --------------------------------------------------------

let currentUid = freshUser();
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = currentUid;
  req.session = { userId: currentUid, role: 'admin' };
  req.authScopes = null;          // ungescopte Session
  req.sessionModuleAccess = null; // keine Modulsperre
  next();
});
app.use('/api/v1/reminders', remindersRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/reminders`;

test.after(() => server.close());

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('GET /pending ueberspringt eine verwaiste Zeile statt sie ohne Titel auszuliefern', async () => {
  const owner = freshUser();
  currentUid = owner;

  const taskId = makeTask(db, owner, { title: 'Echte Aufgabe' });
  insertReminder(db, owner, 'task', taskId);
  // Eine Waise, wie sie ein Tabellen-Rebuild ohne Trigger oder ein von Hand
  // eingespielter Datenbestand hinterlassen könnte.
  insertReminder(db, owner, 'task', 987654);
  insertReminder(db, owner, 'event', 987654);

  const res = await get('/pending');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].entity_id, taskId);
  assert.equal(res.body.data[0].entity_title, 'Echte Aufgabe');
});

test('processDueNotifications schickt keine leere Meldung an eine verwaiste Zeile', async () => {
  const fresh = buildTestDb();
  const owner = freshUser(fresh);
  const store = createNotificationChannelStore({ db: fresh });
  store.createChannel({
    provider: 'ntfy', name: 'ntfy', enabled: true,
    config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {},
  });

  const taskId = makeTask(fresh, owner, { title: 'Muell rausbringen' });
  insertReminder(fresh, owner, 'task', taskId);
  insertReminder(fresh, owner, 'task', 987654);   // Waise
  insertReminder(fresh, owner, 'event', 987654);  // Waise

  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const counters = await processDueNotifications({
    database: fresh,
    channelStore: store,
    pushService: { sendPushToUser: async () => 0 },
    providers,
    now: new Date(),
  });

  assert.equal(counters.due, 1);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Muell rausbringen');
  fresh.close();
});
