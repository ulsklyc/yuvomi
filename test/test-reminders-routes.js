/**
 * Modul: Reminders-Routen-Test (Härtung Coverage-Track)
 * Zweck: HTTP-Schicht von server/routes/reminders.js gegen den echten Router,
 *        die vom bestehenden test-multi-reminders.js NICHT berührt wird:
 *        GET /pending (entity_title-Join task/event/subscription + Fälligkeits-/
 *        dismissed-/Nutzer-Filter + Birthday-Sync-Seiteneffekt), POST/GET/PUT-
 *        Validierungspfade (400), PATCH /:id/dismiss, DELETE /:id, DELETE /?entity
 *        - jeweils mit created_by-Isolation (kein Fremdzugriff, kein Bypass).
 * Ausführen: node --test test/test-reminders-routes.js
 *
 * Netz-frei: nur In-Memory-SQLite. Keine Systemuhr-Kopplung - Fälligkeit via
 * Extremdaten (2000 immer faellig, 2099 nie), Zaehl-Invarianten je frischem Nutzer
 * gegen Akkumulation in der geteilten :memory:-DB.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';

process.env.DB_PATH = ':memory:';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');

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

// --------------------------------------------------------
// Fixtures + Helfer
// --------------------------------------------------------
let userSeq = 0;
function freshUser(role = 'member') {
  userSeq += 1;
  return db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, '$2b$12$x', ?)`,
  ).run(`u${userSeq}`, `User ${userSeq}`, role).lastInsertRowid;
}

function makeTask(owner, title = 'Steuer') {
  return db.prepare(
    `INSERT INTO tasks (title, category, status, created_by) VALUES (?, 'Sonstiges', 'open', ?)`,
  ).run(title, owner).lastInsertRowid;
}
function makeEvent(owner, title = 'Zahnarzt') {
  return db.prepare(
    `INSERT INTO calendar_events (title, start_datetime, created_by) VALUES (?, '2026-05-01T10:00', ?)`,
  ).run(title, owner).lastInsertRowid;
}
function makeSubscription(owner, name = 'Netflix') {
  return db.prepare(
    `INSERT INTO budget_subscriptions (name, amount, currency, billing_cycle, next_payment_date, created_by)
     VALUES (?, 9.99, 'EUR', 'monthly', '2026-06-01', ?)`,
  ).run(name, owner).lastInsertRowid;
}
// remind_at direkt einfügen (umgeht die Route, um Fälligkeit/dismissed frei zu setzen)
function insertReminder(owner, entityType, entityId, remindAt, dismissed = 0) {
  return db.prepare(
    `INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, dismissed) VALUES (?, ?, ?, ?, ?)`,
  ).run(entityType, entityId, remindAt, owner, dismissed).lastInsertRowid;
}

const PAST = '2000-01-01T00:00:00';   // immer <= jetzt  -> faellig
const FUTURE = '2099-12-31T23:59:59';  // immer >  jetzt  -> nicht faellig

let currentUid = freshUser('admin');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = currentUid;
  req.session = { userId: currentUid, role: 'admin' };
  next();
});
app.use('/api/v1/reminders', remindersRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/reminders`;

test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    // fetch verbietet einen Body bei GET/HEAD
    body: body != null && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const at = (h, m) => `2026-05-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;

// --------------------------------------------------------
// GET /pending - entity_title-Join, Fälligkeit, Filter, Isolation
// --------------------------------------------------------
test('GET /pending liefert fällige Erinnerungen mit entity_title über alle drei Typen', async () => {
  const owner = freshUser();
  currentUid = owner;

  const taskId = makeTask(owner, 'Steuererklärung');
  const eventId = makeEvent(owner, 'Zahnarzttermin');
  const subId = makeSubscription(owner, 'Spotify');
  insertReminder(owner, 'task', taskId, PAST);
  insertReminder(owner, 'event', eventId, PAST);
  insertReminder(owner, 'subscription', subId, PAST);

  const res = await call('GET', '/pending');
  assert.equal(res.status, 200);
  // Nur die drei fälligen dieses Nutzers (Isolation via created_by).
  assert.equal(res.body.data.length, 3);
  const byType = Object.fromEntries(res.body.data.map((r) => [r.entity_type, r.entity_title]));
  assert.equal(byType.task, 'Steuererklärung');
  assert.equal(byType.event, 'Zahnarzttermin');
  assert.equal(byType.subscription, 'Spotify');
});

test('GET /pending schließt zukünftige und verworfene Erinnerungen aus', async () => {
  const owner = freshUser();
  currentUid = owner;

  const t = makeTask(owner);
  insertReminder(owner, 'task', t, PAST);              // faellig
  insertReminder(owner, 'task', makeTask(owner), FUTURE); // zukuenftig -> raus
  insertReminder(owner, 'task', makeTask(owner), PAST, 1); // dismissed -> raus

  const res = await call('GET', '/pending');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].entity_id, t);
});

test('GET /pending ist sortiert nach remind_at aufsteigend', async () => {
  const owner = freshUser();
  currentUid = owner;
  insertReminder(owner, 'task', makeTask(owner), '2001-01-01T00:00:00');
  insertReminder(owner, 'task', makeTask(owner), '2000-01-01T00:00:00');
  insertReminder(owner, 'task', makeTask(owner), '2002-01-01T00:00:00');

  const res = await call('GET', '/pending');
  const times = res.body.data.map((r) => r.remind_at);
  assert.deepEqual(times, ['2000-01-01T00:00:00', '2001-01-01T00:00:00', '2002-01-01T00:00:00']);
});

test('GET /pending ist je Nutzer isoliert (kein Fremdzugriff)', async () => {
  const anna = freshUser();
  const bob = freshUser();
  insertReminder(anna, 'task', makeTask(anna), PAST);

  currentUid = bob;
  const res = await call('GET', '/pending');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 0, 'Bob sieht Annas fällige Erinnerungen nicht');
});

test('GET /pending materialisiert Geburtstags-Artefakte (Seiteneffekt)', async () => {
  const owner = freshUser();
  currentUid = owner;
  const bId = db.prepare(
    `INSERT INTO birthdays (name, birth_date, created_by) VALUES ('Opa', '1950-03-14', ?)`,
  ).run(owner).lastInsertRowid;

  // Vor dem Aufruf: noch kein Kalender-Event verknüpft.
  assert.equal(db.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bId).calendar_event_id, null);

  const res = await call('GET', '/pending');
  assert.equal(res.status, 200);

  // syncAllBirthdayReminders hat ein calendar_event materialisiert und verknüpft.
  const linked = db.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bId).calendar_event_id;
  assert.ok(linked, 'Geburtstag hat nach GET /pending ein verknüpftes Kalender-Event');
});

// --------------------------------------------------------
// GET / (single) - Validierung
// --------------------------------------------------------
test('GET / lehnt ungültigen entity_type ab (400)', async () => {
  const res = await call('GET', '/?entity_type=bogus&entity_id=1');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 400);
});

test('GET / lehnt fehlende entity_id ab (400)', async () => {
  const res = await call('GET', '/?entity_type=task');
  assert.equal(res.status, 400);
});

test('GET / liefert null, wenn keine Erinnerung existiert', async () => {
  const owner = freshUser();
  currentUid = owner;
  const res = await call('GET', `/?entity_type=task&entity_id=${makeTask(owner)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null);
});

// --------------------------------------------------------
// POST / - Validierungspfade
// --------------------------------------------------------
test('POST / lehnt ungültigen entity_type ab (400)', async () => {
  const owner = freshUser();
  currentUid = owner;
  const res = await call('POST', '', { entity_type: 'bogus', entity_id: makeTask(owner), remind_at: at(9, 0) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /task, event, or subscription/);
});

test('POST / lehnt fehlenden entity_type ab (400)', async () => {
  const owner = freshUser();
  currentUid = owner;
  const res = await call('POST', '', { entity_id: makeTask(owner), remind_at: at(9, 0) });
  assert.equal(res.status, 400);
});

test('POST / lehnt ungültige entity_id ab (400)', async () => {
  const res = await call('POST', '', { entity_type: 'task', entity_id: 'x', remind_at: at(9, 0) });
  assert.equal(res.status, 400);
});

test('POST / lehnt ungültige remind_at ab (400)', async () => {
  const owner = freshUser();
  currentUid = owner;
  const res = await call('POST', '', { entity_type: 'task', entity_id: makeTask(owner), remind_at: 'kein-datum' });
  assert.equal(res.status, 400);
});

// --------------------------------------------------------
// PUT / - Validierung der Entity-Parameter (Ergänzung zu multi-reminders)
// --------------------------------------------------------
test('PUT / lehnt ungültige entity-Parameter ab (400)', async () => {
  const res = await call('PUT', '/?entity_type=bogus&entity_id=1', { remind_ats: [at(9, 0)] });
  assert.equal(res.status, 400);
});

// --------------------------------------------------------
// PATCH /:id/dismiss - Zustandsübergang + Isolation
// --------------------------------------------------------
test('PATCH /:id/dismiss lehnt ungültige ID ab (400)', async () => {
  const res = await call('PATCH', '/abc/dismiss');
  assert.equal(res.status, 400);
});

test('PATCH /:id/dismiss liefert 404 für nicht existierende Erinnerung', async () => {
  const res = await call('PATCH', '/999999/dismiss');
  assert.equal(res.status, 404);
});

test('PATCH /:id/dismiss verweigert fremde Erinnerung (404, kein Bypass)', async () => {
  const anna = freshUser();
  const rid = insertReminder(anna, 'task', makeTask(anna), PAST);

  currentUid = freshUser(); // fremder Nutzer (auch als admin-Session)
  const res = await call('PATCH', `/${rid}/dismiss`);
  assert.equal(res.status, 404);
  // DB unverändert: weiterhin nicht verworfen.
  assert.equal(db.prepare('SELECT dismissed FROM reminders WHERE id = ?').get(rid).dismissed, 0);
});

test('PATCH /:id/dismiss verwirft eigene Erinnerung und entfernt sie aus /pending', async () => {
  const owner = freshUser();
  currentUid = owner;
  const rid = insertReminder(owner, 'task', makeTask(owner), PAST);

  const res = await call('PATCH', `/${rid}/dismiss`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.id, rid);
  assert.equal(db.prepare('SELECT dismissed FROM reminders WHERE id = ?').get(rid).dismissed, 1);

  const pending = await call('GET', '/pending');
  assert.equal(pending.body.data.length, 0, 'verworfene Erinnerung erscheint nicht mehr in /pending');
});

// --------------------------------------------------------
// DELETE /:id - Löschung + Isolation
// --------------------------------------------------------
test('DELETE /:id lehnt ungültige ID ab (400)', async () => {
  const res = await call('DELETE', '/abc');
  assert.equal(res.status, 400);
});

test('DELETE /:id liefert 404 für nicht existierende Erinnerung', async () => {
  const res = await call('DELETE', '/999999');
  assert.equal(res.status, 404);
});

test('DELETE /:id verweigert fremde Erinnerung (404, kein Bypass)', async () => {
  const anna = freshUser();
  const rid = insertReminder(anna, 'task', makeTask(anna), PAST);

  currentUid = freshUser();
  const res = await call('DELETE', `/${rid}`);
  assert.equal(res.status, 404);
  assert.ok(db.prepare('SELECT id FROM reminders WHERE id = ?').get(rid), 'fremde Erinnerung bleibt bestehen');
});

test('DELETE /:id löscht eigene Erinnerung dauerhaft (204)', async () => {
  const owner = freshUser();
  currentUid = owner;
  const rid = insertReminder(owner, 'task', makeTask(owner), PAST);

  const res = await call('DELETE', `/${rid}`);
  assert.equal(res.status, 204);
  assert.equal(res.body, null);
  assert.equal(db.prepare('SELECT id FROM reminders WHERE id = ?').get(rid), undefined);
});

// --------------------------------------------------------
// DELETE /?entity - Massenlöschung je Entität + Isolation
// --------------------------------------------------------
test('DELETE /?entity lehnt ungültige entity-Parameter ab (400)', async () => {
  const res = await call('DELETE', '/?entity_type=task');
  assert.equal(res.status, 400);
});

test('DELETE /?entity löscht alle eigenen Erinnerungen der Entität, fremde bleiben', async () => {
  const anna = freshUser();
  const bob = freshUser();
  const eventId = makeEvent(anna);
  // Anna: zwei Erinnerungen am selben Event; Bob: eine am selben Event.
  insertReminder(anna, 'event', eventId, at(8, 0));
  insertReminder(anna, 'event', eventId, at(9, 0));
  const bobRid = insertReminder(bob, 'event', eventId, at(7, 0));

  currentUid = anna;
  const res = await call('DELETE', `/?entity_type=event&entity_id=${eventId}`);
  assert.equal(res.status, 204);

  const annaLeft = db.prepare(
    'SELECT COUNT(*) c FROM reminders WHERE entity_type = ? AND entity_id = ? AND created_by = ?',
  ).get('event', eventId, anna).c;
  assert.equal(annaLeft, 0, 'Annas Erinnerungen sind weg');
  assert.ok(db.prepare('SELECT id FROM reminders WHERE id = ?').get(bobRid), 'Bobs Erinnerung bleibt unberührt');
});
