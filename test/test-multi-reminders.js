/**
 * Modul: Multi-Reminders-Test (Discussion #436)
 * Zweck: Neue Reminder-Endpoints gegen den echten Router:
 *        GET /reminders/all (Array), PUT /reminders (Replace-Set: mehrere,
 *        dedupliziert, Cap) sowie Rückwärtskompatibilität der Single-Endpoints
 *        (POST /reminders, GET /reminders) für Tasks/Subscriptions.
 * Ausführen: node --test test/test-multi-reminders.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');

// --------------------------------------------------------
// Test-DB via vollständige Migrationskette
// --------------------------------------------------------
function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

const uid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', '$2b$12$x', 'admin')`).run().lastInsertRowid;
const otherUid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('bob', 'Bob', '$2b$12$x', 'member')`).run().lastInsertRowid;

// Kalender-Termin, an den die Erinnerungen hängen.
const eventId = db.prepare(
  `INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('Zahnarzt', '2026-05-01T10:00', ?)`,
).run(uid).lastInsertRowid;

let currentUid = uid;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = currentUid;
  req.session = { userId: currentUid, role: 'admin' };
  next();
});
// The central error handler of the app: validateRequest() hands its 400 on to it (#2810).
app.use('/api/v1/reminders', remindersRouter);
app.use(createErrorHandler({ warn: () => {}, error: () => {} }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/reminders`;

test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const at = (h, m) => `2026-05-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;

// --------------------------------------------------------
// PUT /reminders — Replace-Set mit mehreren Erinnerungen
// --------------------------------------------------------
test('PUT setzt mehrere Erinnerungen für einen Termin', async () => {
  const res = await call('PUT', `?entity_type=event&entity_id=${eventId}`, {
    remind_ats: [at(9, 45), at(8, 0)],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  // ORDER BY remind_at ASC → 08:00 vor 09:45
  assert.equal(res.body.data[0].remind_at, at(8, 0));
  assert.equal(res.body.data[1].remind_at, at(9, 45));
});

test('GET /all liefert alle Erinnerungen des Termins (aufsteigend)', async () => {
  const res = await call('GET', `/all?entity_type=event&entity_id=${eventId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  assert.deepEqual(res.body.data.map((r) => r.remind_at), [at(8, 0), at(9, 45)]);
});

test('PUT ersetzt die komplette Menge (alte weg, neue drin)', async () => {
  const res = await call('PUT', `?entity_type=event&entity_id=${eventId}`, {
    remind_ats: [at(7, 30)],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].remind_at, at(7, 30));
  const all = await call('GET', `/all?entity_type=event&entity_id=${eventId}`);
  assert.equal(all.body.data.length, 1);
});

test('PUT dedupliziert identische Zeitpunkte', async () => {
  const res = await call('PUT', `?entity_type=event&entity_id=${eventId}`, {
    remind_ats: [at(9, 0), at(9, 0), at(10, 0)],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
});

test('PUT mit leerem Array löscht alle Erinnerungen', async () => {
  const res = await call('PUT', `?entity_type=event&entity_id=${eventId}`, { remind_ats: [] });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 0);
  const all = await call('GET', `/all?entity_type=event&entity_id=${eventId}`);
  assert.equal(all.body.data.length, 0);
});

test('PUT lehnt mehr als 5 Erinnerungen ab', async () => {
  const res = await call('PUT', `?entity_type=event&entity_id=${eventId}`, {
    remind_ats: [at(1, 0), at(2, 0), at(3, 0), at(4, 0), at(5, 0), at(6, 0)],
  });
  assert.equal(res.status, 400);
});

test('PUT lehnt ungültige Zeitangabe ab', async () => {
  const res = await call('PUT', `?entity_type=event&entity_id=${eventId}`, {
    remind_ats: ['kein-datum'],
  });
  assert.equal(res.status, 400);
});

test('PUT verlangt remind_ats als Array', async () => {
  const res = await call('PUT', `?entity_type=event&entity_id=${eventId}`, { remind_ats: 'x' });
  assert.equal(res.status, 400);
});

test('GET /all verlangt gültige entity-Parameter', async () => {
  const res = await call('GET', '/all?entity_type=event');
  assert.equal(res.status, 400);
});

// --------------------------------------------------------
// Isolation je Nutzer
// --------------------------------------------------------
test('Erinnerungen sind je Nutzer isoliert', async () => {
  currentUid = uid;
  await call('PUT', `?entity_type=event&entity_id=${eventId}`, { remind_ats: [at(9, 45)] });
  currentUid = otherUid;
  const bobAll = await call('GET', `/all?entity_type=event&entity_id=${eventId}`);
  assert.equal(bobAll.body.data.length, 0, 'Bob darf Annas Erinnerungen nicht sehen');
  // Bobs eigenes PUT überschreibt Annas nicht.
  await call('PUT', `?entity_type=event&entity_id=${eventId}`, { remind_ats: [at(6, 0)] });
  currentUid = uid;
  const annaAll = await call('GET', `/all?entity_type=event&entity_id=${eventId}`);
  assert.equal(annaAll.body.data.length, 1);
  assert.equal(annaAll.body.data[0].remind_at, at(9, 45));
});

// --------------------------------------------------------
// Rückwärtskompatibilität: Single-Endpoints (Tasks/Subscriptions)
// --------------------------------------------------------
test('POST + GET (single) funktionieren weiterhin und ersetzen auf eine Erinnerung', async () => {
  const taskId = db.prepare(
    `INSERT INTO tasks (title, category, status, created_by) VALUES ('Steuer', 'Sonstiges', 'open', ?)`,
  ).run(uid).lastInsertRowid;

  const p1 = await call('POST', '', { entity_type: 'task', entity_id: taskId, remind_at: at(9, 0) });
  assert.equal(p1.status, 201);
  const p2 = await call('POST', '', { entity_type: 'task', entity_id: taskId, remind_at: at(10, 0) });
  assert.equal(p2.status, 201);

  // Single-GET liefert nur die (zuletzt gesetzte) eine Erinnerung.
  const g = await call('GET', `?entity_type=task&entity_id=${taskId}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.data.remind_at, at(10, 0));
  // Und im Datensatz existiert genau eine Zeile (POST ersetzt).
  const all = await call('GET', `/all?entity_type=task&entity_id=${taskId}`);
  assert.equal(all.body.data.length, 1);
});
