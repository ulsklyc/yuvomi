/**
 * Modul: Push-Test
 * Zweck: VAPID-Auflösung, Subscribe/Unsubscribe-Routen, Versand, Scheduler.
 * Ausführen: node --experimental-sqlite test/test-push.js
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import express from 'express';
import { buildRouter } from '../server/routes/push.js';
import { processDuePushes } from '../server/services/push-scheduler.js';
import { MIGRATIONS } from '../server/db.js';
import { fetchRetry } from './fetch-retry.js';

// --- Minimal-Schema -------------------------------------------------------
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE users (deactivated_at TEXT, id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', family_role TEXT, schedule_reminder_offset_minutes INTEGER,
      -- D6: der Subjekt-Name auf der geerbten Vorsorge-Erinnerung
      -- kommt aus users.display_name.
      display_name TEXT NOT NULL DEFAULT '');
    CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT);
    -- Zweite Rechte-Achse des Vorrats-Voll-Syncs (#467).
    CREATE TABLE access_permissions (
      subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL, access TEXT NOT NULL,
      PRIMARY KEY (subject_type, subject_id, resource_type, resource_key));
    -- Die Sichtbarkeitsspalten und Zuweisungstabellen, an denen die Zustellung
    -- seit services/reminder-targets.js haengt - mit den Vorgaben des echten
    -- Schemas, damit eine Zeile ohne Angabe wie in Produktion fuer alle da ist.
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visibility TEXT NOT NULL DEFAULT 'all');
    CREATE TABLE task_assignments (task_id INTEGER NOT NULL, user_id INTEGER NOT NULL);
    CREATE TABLE calendar_events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      created_by INTEGER, visibility TEXT NOT NULL DEFAULT 'all',
      external_source TEXT NOT NULL DEFAULT 'local', subscription_id INTEGER);
    CREATE TABLE event_assignments (event_id INTEGER NOT NULL, user_id INTEGER NOT NULL);
    CREATE TABLE ics_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, shared INTEGER NOT NULL DEFAULT 0, created_by INTEGER);
    CREATE TABLE budget_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      amount REAL, currency TEXT, next_payment_date TEXT,
      owner_id INTEGER, visibility TEXT NOT NULL DEFAULT 'shared');
    CREATE TABLE inventory_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      purchase_date TEXT, warranty_months INTEGER);
    CREATE TABLE inventory_item_dates (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
      label TEXT NOT NULL, date TEXT NOT NULL);
    CREATE TABLE pantry_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1, expires_on TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
    -- Minimal, nur genug fuer den 'document_expiry'-Zweig in processDueNotifications().
    -- Sichtbarkeit und Freigaben wie im echten Schema: die Zustellung fragt
    -- seit services/reminder-targets.js, ob ein Dokument fuer alle da ist.
    CREATE TABLE family_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      expires_at TEXT, created_by INTEGER, visibility TEXT NOT NULL DEFAULT 'family');
    CREATE TABLE family_document_access (document_id INTEGER NOT NULL, user_id INTEGER NOT NULL);
    -- Minimal, nur genug fuer den 'health_prevention_due'-Zweig in
    -- processDueNotifications() UND fuer syncAllPreventionReminders() -
    -- ohne diese zwei Tabellen scheitert schon die Sync-Abfrage mit "no such
    -- table", bevor die due-Abfrage ueberhaupt drankommt.
    CREATE TABLE health_prevention_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE health_prevention_records (id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type_id INTEGER REFERENCES health_prevention_types(id) ON DELETE SET NULL,
      name TEXT);
    -- Periodic notification delivery reconciles fasting reminders before it
    -- selects due rows. Keep this minimal scheduler fixture on the same
    -- service boundary even though these tests do not seed a fast.
    CREATE TABLE health_fasting_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      default_goal_minutes INTEGER,
      remind_goal INTEGER NOT NULL DEFAULT 0,
      remind_next_start INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE health_fasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_at TEXT NOT NULL,
      end_at TEXT,
      goal_minutes INTEGER
    );
    -- Minimal, wie inventory_items/pantry_items daneben - nur genug fuer die
    -- CASE-Zweige in processDueNotifications() und den Schichtplan-Sync.
    CREATE TABLE schedule_shift_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      start_time TEXT, end_time TEXT);
    CREATE TABLE schedule_reminder_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_key TEXT NOT NULL,
      shift_type_id INTEGER NOT NULL REFERENCES schedule_shift_types(id) ON DELETE CASCADE,
      pattern_day_id INTEGER
    );
    CREATE UNIQUE INDEX idx_schedule_reminder_entries_slot_test
      ON schedule_reminder_entries(user_id, date_key, COALESCE(pattern_day_id, 0));
    CREATE TABLE schedule_extra_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_key TEXT NOT NULL,
      shift_type_id INTEGER NOT NULL REFERENCES schedule_shift_types(id) ON DELETE CASCADE,
      note TEXT,
      reminder_offset_minutes INTEGER,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('task','event','subscription','inventory_item','inventory_tracked_date','pantry_item','cycle_period','cycle_log_nudge','schedule_entry','schedule_extra_entry','waste_pickup','document_expiry','fasting_goal','fasting_next_start')),
      entity_id INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      -- D6-Betreuungs-Fan-out: processDueNotifications() selektiert
      -- r.assigned_from ungeachtet des entity_type, also muss die Spalte hier stehen.
      assigned_from INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    -- Gleiche Bauart wie schedule_reminder_entries darueber: die
    -- CASE-Zweige fuer 'waste_pickup' in processDueNotifications() lesen beide
    -- Tabellen, also muessen beide hier stehen. Fehlten sie, brach der ganze
    -- Push-Test mit "no such table: waste_reminder_entries" ab - und weil
    -- "npm test" eine &&-Kette ist, kam danach KEINE Suite mehr dran (#1063).
    CREATE TABLE waste_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'trash-2', color TEXT NOT NULL DEFAULT '#22C55E',
      archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE waste_reminder_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type_id INTEGER NOT NULL REFERENCES waste_types(id) ON DELETE CASCADE,
      date_key TEXT NOT NULL,
      UNIQUE (user_id, type_id, date_key)
    );
    CREATE TABLE cycle_reminder_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      anchor_date TEXT NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE TABLE push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_used_at TEXT
    );
  `);
  db.exec(MIGRATIONS.find((m) => m.version === 60).up);
  // Die Wand-Pause (#1904) kommt aus der echten Migration, nicht von Hand.
  MIGRATIONS.find((m) => m.version === 256).up(db);
  db.prepare("INSERT INTO users (id, username) VALUES (1,'alice'),(2,'bob')").run();
  return db;
}

// --- web-push Mock --------------------------------------------------------
function makeWebpushMock() {
  const calls = [];
  const subjects = [];
  return {
    calls,
    subjects,
    generateVAPIDKeys: () => ({ publicKey: 'PUB_GEN', privateKey: 'PRIV_GEN' }),
    setVapidDetails: (subject) => { subjects.push(subject); },
    sendNotification: async (sub, payload) => {
      calls.push({ endpoint: sub.endpoint, payload });
      if (sub.endpoint.includes('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
      if (sub.endpoint.includes('boom')) { const e = new Error('boom'); e.statusCode = 500; throw e; }
      return { statusCode: 201 };
    },
  };
}

/** Env-Variablen um einen Aufruf herum setzen und danach exakt wiederherstellen. */
function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const { createPushService } = await import('../server/services/push.js');

test('generates and persists VAPID keys on first use', () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  const svc = createPushService({ db, webpush });
  const key = svc.getPublicKey();
  assert.equal(key, 'PUB_GEN');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='push_vapid_public'").get().value, 'PUB_GEN');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='push_vapid_private'").get().value, 'PRIV_GEN');
});

test('reuses persisted VAPID keys (no regeneration)', () => {
  const db = makeDb();
  db.prepare("INSERT INTO sync_config (key,value) VALUES ('push_vapid_public','PUB_DB'),('push_vapid_private','PRIV_DB')").run();
  const webpush = makeWebpushMock();
  const svc = createPushService({ db, webpush });
  assert.equal(svc.getPublicKey(), 'PUB_DB');
});

// --- VAPID-Subject --------------------------------------------------------
// Apple (web.push.apple.com) weist ein VAPID-JWT mit nicht routbarem `sub` mit
// 403 BadJwtToken ab. Der frühere Default `mailto:admin@localhost` liess Push auf
// iOS/iPadOS damit komplett ausfallen, während Android weiter auslieferte (#580).
function resolvedSubject(db, env = {}) {
  const webpush = makeWebpushMock();
  return withEnv({ VAPID_SUBJECT: undefined, BASE_URL: undefined, ...env }, () => {
    createPushService({ db, webpush }).ensureVapid();
    return webpush.subjects.at(-1);
  });
}

test('VAPID subject never falls back to a non-routable host', () => {
  const subject = resolvedSubject(makeDb());
  assert.doesNotMatch(subject, /localhost/, 'Apple rejects a localhost subject with 403');
  assert.match(subject, /^mailto:[^@]+@[^@.]+\.[a-z]{2,}$/i);
});

test('VAPID_SUBJECT wins over every other source', () => {
  const db = makeDb();
  db.prepare("INSERT INTO sync_config (key,value) VALUES ('email_from_address','box@mail.example')").run();
  const subject = resolvedSubject(db, {
    VAPID_SUBJECT: 'mailto:me@example.org',
    BASE_URL: 'https://yuvomi.example.net',
  });
  assert.equal(subject, 'mailto:me@example.org');
});

test('VAPID subject uses the configured sender address before BASE_URL', () => {
  const db = makeDb();
  db.prepare("INSERT INTO sync_config (key,value) VALUES ('email_from_address','box@mail.example')").run();
  assert.equal(resolvedSubject(db, { BASE_URL: 'https://yuvomi.example.net' }), 'mailto:box@mail.example');
});

test('VAPID subject falls back to the BASE_URL origin', () => {
  const subject = resolvedSubject(makeDb(), { BASE_URL: 'https://yuvomi.example.net/app/' });
  assert.equal(subject, 'https://yuvomi.example.net');
});

test('VAPID subject accepts a bare mail address without the mailto scheme', () => {
  assert.equal(resolvedSubject(makeDb(), { VAPID_SUBJECT: 'me@example.org' }), 'mailto:me@example.org');
});

test('VAPID subject discards unusable configured values', () => {
  const fallback = resolvedSubject(makeDb());
  const unusable = [
    'mailto:admin@localhost',
    'mailto:admin',
    'https://localhost:3000',
    'https://yuvomi.local',
    'http://192.168.1.10.lan',
    'ftp://example.org',
    'not a subject',
    '   ',
  ];
  for (const value of unusable) {
    // Ohne weiteren Kandidaten muss der Platzhalter greifen, nie der kaputte Wert.
    assert.equal(resolvedSubject(makeDb(), { VAPID_SUBJECT: value }), fallback, `should discard ${value}`);
  }
});

test('VAPID subject skips an unusable sender address and keeps BASE_URL', () => {
  const db = makeDb();
  db.prepare("INSERT INTO sync_config (key,value) VALUES ('email_from_address','admin@localhost')").run();
  assert.equal(resolvedSubject(db, { BASE_URL: 'https://yuvomi.example.net' }), 'https://yuvomi.example.net');
});

test('sendPushToUser sends to all subs and reports count', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/ok1','p','a'),(1,'https://push/ok2','p','a')").run();
  const svc = createPushService({ db, webpush });
  const sent = await svc.sendPushToUser(1, { title: 'T', body: 'B' });
  assert.equal(sent, 2);
  assert.equal(webpush.calls.length, 2);
});

test('sendPushToUser deletes gone subs but keeps others', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/ok','p','a'),(1,'https://push/gone','p','a')").run();
  const svc = createPushService({ db, webpush });
  const sent = await svc.sendPushToUser(1, { title: 'T' });
  assert.equal(sent, 1);
  const remaining = db.prepare('SELECT endpoint FROM push_subscriptions').all().map(r => r.endpoint);
  assert.deepEqual(remaining, ['https://push/ok']);
});

test('sendPushToUser keeps sub on transient (500) error', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/boom','p','a')").run();
  const svc = createPushService({ db, webpush });
  const sent = await svc.sendPushToUser(1, { title: 'T' });
  assert.equal(sent, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c, 1);
});

test('sendPushToUser skips wall-paused sub, delivers to others of the same user (#1904)', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  // wall_paused_at auf jetzt setzen - innerhalb der 12-Stunden-Grenze.
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, wall_paused_at)
    VALUES (1,'https://push/wall','p','a', datetime('now')),(1,'https://push/phone','p','a',NULL)
  `).run();
  const svc = createPushService({ db, webpush });
  const sent = await svc.sendPushToUser(1, { title: 'T' });
  assert.equal(sent, 1, 'nur das nicht-pausierte Abo wird bedient');
  assert.equal(webpush.calls[0].endpoint, 'https://push/phone');
});

test('sendPushToUser delivers after wall_paused_at expires (>12h ago) (#1904)', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, wall_paused_at)
    VALUES (1,'https://push/wall','p','a', datetime('now', '-13 hours'))
  `).run();
  const svc = createPushService({ db, webpush });
  const sent = await svc.sendPushToUser(1, { title: 'T' });
  assert.equal(sent, 1, 'abgelaufene Pause wird ignoriert');
});

test('PUT /wall-mode setzt und loescht wall_paused_at fuer das eigene Abo (#1904)', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock());
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/tab','p','a')").run();
  const put = (active) => fetchRetry(`${app.baseUrl}/wall-mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push/tab', active }),
  });
  const r1 = await put(true);
  assert.equal(r1.status, 204);
  const row1 = db.prepare("SELECT wall_paused_at FROM push_subscriptions WHERE endpoint = 'https://push/tab'").get();
  assert.ok(typeof row1.wall_paused_at === 'string' && row1.wall_paused_at.length > 0, 'wall_paused_at ist ein Zeitstempel');
  const r2 = await put(false);
  assert.equal(r2.status, 204);
  const row2 = db.prepare("SELECT wall_paused_at FROM push_subscriptions WHERE endpoint = 'https://push/tab'").get();
  assert.equal(row2.wall_paused_at, null, 'wall_paused_at ist NULL nach dem Aufheben');
});

test('PUT /wall-mode aendert nur das eigene Abo - nicht das eines anderen Nutzers (#1904)', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock(), 1);
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (2,'https://push/bob','p','a')").run();
  const r = await fetchRetry(`${app.baseUrl}/wall-mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push/bob', active: true }),
  });
  assert.equal(r.status, 204);
  const row = db.prepare("SELECT wall_paused_at FROM push_subscriptions WHERE endpoint = 'https://push/bob'").get();
  assert.equal(row.wall_paused_at, null, 'AND user_id = ? verhindert, dass Nutzer 1 das Abo von Nutzer 2 pausiert');
});

/**
 * Startet die Push-Routen hinter einem echten Listener und meldet die Basis-URL.
 *
 * Der Abbau haengt NICHT am Testende (gemessen am 09.09.2026): frueher schloss
 * jeder Test den Server in seiner letzten Zeile. Warf eine Assertion davor, war
 * diese Zeile unerreichbar, der Socket blieb offen - und der Prozess endete
 * nicht mehr. Im Log stand der `✖`, das Suiten-Ende fehlte, und `npm test` hing
 * unbegrenzt statt rot zu werden. Betroffen war jeder Test dieser Datei.
 *
 * Deshalb raeumt `after()` auf, wie in `test/server-ready.js` (PR #1088).
 * Innerhalb eines `test()`-Callbacks bindet der Hook an genau diesen Test und
 * laeuft direkt danach - auch nach einer geworfenen Assertion.
 */
async function startApp(db, webpush, userId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = userId; next(); });
  const { createPushService } = await import('../server/services/push.js');
  const pushService = createPushService({ db, webpush });
  app.use('/', buildRouter({ pushService, database: db }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

  after(async () => {
    // Erst die Keep-Alive-Verbindungen von `fetch`: `close()` wartet sonst auf
    // einen Socket, den niemand mehr schliesst.
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('GET /vapid-public-key returns the key', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock());
  const res = await fetchRetry(`${app.baseUrl}/vapid-public-key`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.key, 'PUB_GEN');
});

test('POST /subscribe inserts then upserts the subscription', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock());
  const body = { endpoint: 'https://push/x', keys: { p256dh: 'PP', auth: 'AA' } };
  let res = await fetchRetry(`${app.baseUrl}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 201);
  res = await fetchRetry(`${app.baseUrl}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, keys: { p256dh: 'PP2', auth: 'AA2' } }) });
  assert.equal(res.status, 201);
  const rows = db.prepare('SELECT p256dh FROM push_subscriptions WHERE endpoint = ?').all('https://push/x');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].p256dh, 'PP2');
});

test('POST /subscribe rejects missing keys', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock());
  const res = await fetchRetry(`${app.baseUrl}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://push/x' }) });
  assert.equal(res.status, 400);
});

test('POST /unsubscribe removes the subscription', async () => {
  const db = makeDb();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/x','p','a')").run();
  const app = await startApp(db, makeWebpushMock());
  const res = await fetchRetry(`${app.baseUrl}/unsubscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://push/x' }) });
  assert.equal(res.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c, 0);
});

test('POST /test forwards client-provided localized text', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/x','p','a')").run();
  const app = await startApp(db, webpush);
  const res = await fetchRetry(`${app.baseUrl}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Titel', body: 'Inhalt' }) });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.sent, 1);
  assert.equal(json.data.devices, 1);
  assert.match(webpush.calls[0].payload, /Titel/);
});

test('POST /test reports sent 0 / devices 0 when nothing is registered', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock());
  const res = await fetchRetry(`${app.baseUrl}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.sent, 0);
  assert.equal(json.data.devices, 0);
});

test('POST /test reports sent 0 but devices 1 when the subscription is gone', async () => {
  const db = makeDb();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/gone','p','a')").run();
  const app = await startApp(db, makeWebpushMock());
  const res = await fetchRetry(`${app.baseUrl}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.sent, 0);
  // Vor dem Senden gezaehlt: der Client kann "abgelaufen" von "nie registriert" trennen.
  assert.equal(json.data.devices, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c, 0);
});

test('POST /test only counts the current user devices', async () => {
  const db = makeDb();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (2,'https://push/bob','p','a')").run();
  const app = await startApp(db, makeWebpushMock(), 1);
  const res = await fetchRetry(`${app.baseUrl}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  const json = await res.json();
  assert.equal(json.data.devices, 0);
});

function pastIso() { return new Date(Date.now() - 60_000).toISOString(); }
function futureIso() { return new Date(Date.now() + 3_600_000).toISOString(); }

test('scheduler pushes only due, undismissed, unpushed reminders and marks them', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  const { createPushService } = await import('../server/services/push.js');
  const pushService = createPushService({ db, webpush });
  db.prepare("INSERT INTO tasks (id,title,created_by) VALUES (1,'Müll rausbringen',1)").run();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/ok','p','a')").run();
  // due + open  -> push
  db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('task',1,?,1)").run(pastIso());
  // future -> skip
  db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('task',1,?,1)").run(futureIso());
  // dismissed -> skip
  db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,dismissed,created_by) VALUES ('task',1,?,1,1)").run(pastIso());

  const r1 = await processDuePushes({ database: db, pushService });
  assert.equal(r1.pushed, 1);
  assert.equal(webpush.calls.length, 1);
  assert.match(webpush.calls[0].payload, /Müll rausbringen/);

  // second run: nothing new (pushed_at set)
  const r2 = await processDuePushes({ database: db, pushService });
  assert.equal(r2.pushed, 0);
  assert.equal(webpush.calls.length, 1);
});

test('scheduler marks pushed_at even when user has no subscriptions', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  const { createPushService } = await import('../server/services/push.js');
  const pushService = createPushService({ db, webpush });
  db.prepare("INSERT INTO tasks (id,title,created_by) VALUES (1,'X',1)").run();
  db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('task',1,?,1)").run(pastIso());
  await processDuePushes({ database: db, pushService });
  assert.equal(db.prepare('SELECT pushed_at FROM reminders').get().pushed_at !== null, true);
});

// ---------------------------------------------------------------------------
// Client-seitige Verdrahtung: wall-mode.js ruft den Hook nur bei Uebergaengen.
// isWallActive() liefert den Zustand fuer den einmaligen Boot-Report in router.js.
// wall-mode.js hat nur einen Browser-Import (timezone.js) - Stubs fuer document
// und localStorage genuegen (#1904).
// ---------------------------------------------------------------------------
test('wall-mode: syncWallMode ruft den Hook nur bei Uebergaengen, isWallActive meldet den gesetzten Zustand (#1904)', async () => {
  const attrs = new Map();
  const root = {
    hasAttribute: (k) => attrs.has(k),
    toggleAttribute: (k, v) => { if (v) attrs.set(k, ''); else attrs.delete(k); },
    getAttribute: (k) => attrs.get(k) ?? null,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
  };
  const storage = new Map();
  global.document = { documentElement: root };
  global.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  global.window = { yuvomi: {} };

  const { syncWallMode, onWallActiveChange, isWallActive, setWallModeEnabled } = await import('../public/utils/wall-mode.js');
  const calls = [];
  onWallActiveChange((v) => calls.push(v));

  // Kaltstart auf `/`: theme-init.js setzt data-wall-mode schon VOR syncWallMode.
  // Der Hook bleibt stumm (kein Uebergang), aber isWallActive() liefert true
  // fuer den einmaligen Boot-Report in router.js (initPushAndReport).
  setWallModeEnabled(true);
  root.toggleAttribute('data-wall-mode', true);
  syncWallMode('/');
  assert.deepEqual(calls, [], 'Kaltstart auf `/` ohne Uebergang: Hook bleibt stumm');
  assert.equal(isWallActive(), true, 'isWallActive() liefert true - Boot-Report setzt Pause');

  // Kaltstart ABSEITS von `/` mit veralteter Pause (wall-mode an, path != `/`).
  root.toggleAttribute('data-wall-mode', false);
  syncWallMode('/calendar');
  assert.deepEqual(calls, [], 'Kaltstart auf `/calendar`: kein Uebergang, kein Aufruf');
  assert.equal(isWallActive(), false, 'isWallActive() liefert false - Boot-Report hebt Pause auf');

  // Uebergang waehrend der Sitzung: Wand verlassen.
  root.toggleAttribute('data-wall-mode', true);
  syncWallMode('/calendar');
  assert.deepEqual(calls, [false], 'Verlassen der Wand: Hook mit false');

  // Uebergang waehrend der Sitzung: zur Wand zurueck.
  calls.length = 0;
  syncWallMode('/');
  assert.deepEqual(calls, [true], 'Rueckkehr zur Wand: Hook mit true');

  onWallActiveChange(null);
  delete global.document;
  delete global.localStorage;
  delete global.window;
});

// ---------------------------------------------------------------------------
// Boot-time report (#1904): router.js laesst sich nicht importieren (es haengt
// beim Laden Listener an `window` und zieht die halbe App nach). Gefahren wird
// deshalb der ECHTE Quelltext der Verdrahtung: die Stuecke aus router.js laufen
// in einem Bereich, in dem jeder freie Name eine Attrappe ist. Ein Textguard auf
// den Koerper von initPushAndReport sah nicht, ob navigate() sie ueberhaupt
// bekommt - `initPush: initPushAndReport` -> `initPush` blieb gruen.
// ---------------------------------------------------------------------------
const routerSource = () => readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');

/** Ab `start` bis zur Klammer, die die erste `open`-Klammer schliesst (Strings und Kommentare uebersprungen). */
function balancedFrom(src, start, open) {
  const close = { '(': ')', '{': '}' };
  let i = src.indexOf(open, start);
  assert.ok(start >= 0 && i >= 0, `Anfang nicht gefunden: ${src.slice(start, start + 60)}`);
  const stack = [];
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') stack.push(c === '[' ? ']' : close[c]);
    else if (c === ')' || c === '}' || c === ']') {
      assert.equal(c, stack.pop(), 'Klammern in router.js passen nicht zusammen');
      if (stack.length === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail('keine schliessende Klammer');
}

/** Fuehrt Quelltext aus router.js aus; freie Namen kommen aus `stubs`, sonst ist es eine leere Funktion. */
function runRouterSnippet(code, stubs) {
  const noop = () => {};
  const scope = new Proxy(stubs, {
    has: (target, key) => key in target || (typeof key === 'string' && !(key in globalThis)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? target[key] : noop),
  });
  // `with` braucht den Sloppy-Mode einer Function; der Code ist der eigene Quelltext aus router.js.
  return new Function('scope', `with (scope) { return (async () => {\n${code}\n})(); }`)(scope);
}

test('router.js: navigate() bekommt initPushAndReport als initPush - der Boot-Report meldet den Wandzustand (#1904)', async () => {
  const src = routerSource();
  const fn = balancedFrom(src, src.indexOf('async function initPushAndReport()'), '{');
  const call = balancedFrom(src, src.indexOf('createNavigate(routerState'), '(');
  const calls = [];
  let deps = null;
  let wall = true;
  await runRouterSnippet(`${fn}\n${call};`, {
    createNavigate: (_state, d) => { deps = d; return () => {}; },
    initPush: async () => { calls.push('initPush'); },
    reportWallPauseState: (active) => { calls.push(['report', active]); },
    isWallActive: () => wall,
  });
  assert.equal(typeof deps?.initPush, 'function', 'createNavigate bekommt ein initPush');
  await deps.initPush();
  assert.deepEqual(calls, ['initPush', ['report', true]],
    'navigate() startet Push und meldet danach den Wandzustand - Kaltstart auf der Wand pausiert');
  calls.length = 0;
  wall = false;
  await deps.initPush();
  assert.deepEqual(calls, ['initPush', ['report', false]],
    'ohne Wand meldet der Boot-Report false - eine liegengebliebene Pause heilt');
});

test('router.js: der visibilitychange-Listener meldet beim Aufwachen den Wandzustand (#1904)', async () => {
  const src = routerSource();
  const snippets = [...src.matchAll(/document\.addEventListener\(\s*['"]visibilitychange['"]/g)]
    .map((m) => balancedFrom(src, m.index, '('));
  assert.ok(snippets.length > 0, 'router.js haengt einen visibilitychange-Listener an');
  const listeners = [];
  const reports = [];
  let wall = true;
  const doc = { hidden: false, addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); } };
  for (const snippet of snippets) {
    await runRouterSnippet(`${snippet};`, {
      document: doc,
      reportWallPauseState: (active) => { reports.push(active); },
      isWallActive: () => wall,
    });
  }
  const wake = () => { for (const fn of listeners) fn(); };

  wake();
  assert.deepEqual(reports, [true], 'sichtbar mit Wand: die Pause wird erneuert');
  reports.length = 0;
  wall = false;
  wake();
  assert.deepEqual(reports, [false], 'sichtbar ohne Wand: eine liegengebliebene Pause wird aufgehoben');
  reports.length = 0;
  doc.hidden = true;
  wake();
  assert.deepEqual(reports, [], 'beim Verstecken meldet die Seite nichts');
});

test('POST /test hebt die Wand-Pause nur am anfragenden Geraet auf, nicht bei anderen Abos desselben Nutzers (#1904)', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  // Beide Abos sind pausiert; nur das Telefon schickt den Test.
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth,wall_paused_at) VALUES (1,'https://push/phone','p','a',datetime('now'))").run();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth,wall_paused_at) VALUES (1,'https://push/wall','p','a',datetime('now'))").run();
  const app = await startApp(db, webpush);
  const res = await fetchRetry(`${app.baseUrl}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push/phone' }),
  });
  assert.equal(res.status, 200);
  const phone = db.prepare("SELECT wall_paused_at FROM push_subscriptions WHERE endpoint = 'https://push/phone'").get();
  assert.equal(phone.wall_paused_at, null, 'die Pause des anfragenden Telefons wird aufgehoben');
  const wall = db.prepare("SELECT wall_paused_at FROM push_subscriptions WHERE endpoint = 'https://push/wall'").get();
  assert.ok(wall.wall_paused_at !== null, 'die Pause des Wandtablets bleibt');
});

test('POST /test ohne endpoint laesst alle Wand-Pausen unveraendert (#1904)', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth,wall_paused_at) VALUES (1,'https://push/wall','p','a',datetime('now'))").run();
  const app = await startApp(db, webpush);
  const res = await fetchRetry(`${app.baseUrl}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Test' }),
  });
  assert.equal(res.status, 200);
  const wall = db.prepare("SELECT wall_paused_at FROM push_subscriptions WHERE endpoint = 'https://push/wall'").get();
  assert.ok(wall.wall_paused_at !== null, 'keine Pause geloescht ohne endpoint-Angabe');
});

test('router.js: onWallActiveChange(reportWallPauseState) und Lebendauer-Erneuerung sind verdrahtet (#1904)', () => {
  const src = routerSource();
  assert.match(src, /onWallActiveChange\s*\(\s*reportWallPauseState\s*\)/,
    'onWallActiveChange(reportWallPauseState) muss in router.js stehen');
  // Der visibilitychange-Listener laeuft als Verhalten im Test oben.
  assert.match(src, /setInterval\s*\(.*reportWallPauseState.*60\s*\*\s*60\s*\*\s*1000/s,
    'stuendlicher setInterval fuer laufende Wand muss in router.js stehen');
});

test('POST /subscribe setzt wall_paused_at zurueck wenn ein anderer Nutzer dasselbe Endpoint uebernimmt (#1904)', async () => {
  const db = makeDb();
  // Nutzer 1 hat das Geraet mit aktiver Wand-Pause.
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth,wall_paused_at) VALUES (1,'https://push/shared','p','a',datetime('now'))").run();
  const app = await startApp(db, makeWebpushMock(), 2);
  const res = await fetchRetry(`${app.baseUrl}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push/shared', keys: { p256dh: 'p2', auth: 'a2' } }),
  });
  assert.equal(res.status, 201);
  const row = db.prepare("SELECT wall_paused_at FROM push_subscriptions WHERE endpoint = 'https://push/shared'").get();
  assert.equal(row.wall_paused_at, null, 'Nutzerwechsel loescht wall_paused_at');
});

test('POST /subscribe behält wall_paused_at wenn derselbe Nutzer erneut abonniert (#1904)', async () => {
  const db = makeDb();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth,wall_paused_at) VALUES (1,'https://push/self','p','a',datetime('now'))").run();
  const app = await startApp(db, makeWebpushMock(), 1);
  const res = await fetchRetry(`${app.baseUrl}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push/self', keys: { p256dh: 'p2', auth: 'a2' } }),
  });
  assert.equal(res.status, 201);
  const row = db.prepare("SELECT wall_paused_at FROM push_subscriptions WHERE endpoint = 'https://push/self'").get();
  assert.ok(row.wall_paused_at !== null, 'wall_paused_at bleibt bei erneut-Abonnieren desselben Nutzers');
});

// --- SSRF-Schutz und Frist des Versands -----------------------------------
// Ein Push-Endpoint ist ein Ziel, das ein Mitglied selbst setzt und an das der
// Server dann sendet. Alles hier bleibt auf Loopback oder ohne Netz.
import https from 'node:https';
import net from 'node:net';
import { createECDH, randomBytes } from 'node:crypto';
import realWebpush from 'web-push';

function realSubscriptionKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

/** Loopback-Listener, der nur zaehlt, ob jemand verbindet. `hang` haelt den Socket offen. */
async function startProbeListener({ hang = false } = {}) {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (!hang) socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    get connections() { return connections; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

test('checkPushEndpoint: nur oeffentliche https-Ziele', async () => {
  const { checkPushEndpoint } = await import('../server/services/push.js');
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
  ]) {
    assert.equal(checkPushEndpoint(ok).ok, true, ok);
  }
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/x',
    'https://127.0.0.1:8443/x',
    'https://2130706433/x',
    'https://0x7f.1/x',
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/x',
    'https://192.168.1.10/x',
    'https://localhost/x',
    'https://nas.local/x',
    'https://svc.internal/x',
    'ftp://example.com/x',
    'not a url',
    '',
    null,
  ]) {
    assert.equal(checkPushEndpoint(bad).ok, false, String(bad));
  }
});

// web-push liest den Endpoint mit dem alten url.parse, die Pruefung mit WHATWG.
// url.parse schneidet einen Hostnamen am ersten Zeichen ab, das es dort nicht
// erwartet - aus `127.0.0.1{.evil.com` (fuer WHATWG ein Domainname) wird das
// IP-Literal 127.0.0.1, und fuer ein Literal fragt Node den Guard-Lookup nie.
test('checkPushEndpoint: url.parse und WHATWG sehen denselben Host', async () => {
  const { checkPushEndpoint } = await import('../server/services/push.js');
  const { parse } = await import('node:url');
  for (const bad of [
    'https://127.0.0.1{.evil.com/x',
    'https://169.254.169.254{.evil.com/latest/meta-data',
    'https://10.0.0.5}.evil.com/x',
    'https://192.168.1.10`.evil.com/x',
    'https://127.0.0.1|.evil.com/x',
    'https://127.0.0.1~.evil.com/x',
    'https://127.0.0.1!.evil.com/x',
    'https://127.0.0.1$.evil.com/x',
    "https://127.0.0.1'.evil.com/x",
    'https://localhost{.evil.com/x',
  ]) {
    const res = checkPushEndpoint(bad);
    assert.equal(res.ok, false, bad);
  }
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/abc']) {
    const res = checkPushEndpoint(ok);
    assert.equal(res.ok, true, ok);
    assert.equal(parse(res.href).hostname, new URL(res.href).hostname, ok);
  }
});

test('POST /subscribe weist einen Endpoint ins eigene Netz ab und speichert nichts', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock());
  for (const endpoint of ['https://127.0.0.1:9/probe', 'https://169.254.169.254/x', 'https://localhost/x', 'http://push.example.com/x']) {
    const res = await fetchRetry(`${app.baseUrl}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, keys: { p256dh: 'PP', auth: 'AA' } }),
    });
    assert.equal(res.status, 400, endpoint);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('sendPushToUser sendet nie an eine Bestandszeile mit internem Endpoint und entfernt sie', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://169.254.169.254/x','p','a'),(1,'https://push/ok','p','a')").run();
  const svc = createPushService({ db, webpush });
  const sent = await svc.sendPushToUser(1, { title: 't' });
  assert.equal(sent, 1);
  assert.deepEqual(webpush.calls.map((c) => c.endpoint), ['https://push/ok']);
  // Wie ein erloschenes Abo entfernt: zustellbar wird diese Zeile nie.
  assert.deepEqual(db.prepare('SELECT endpoint FROM push_subscriptions').all().map((r) => r.endpoint), ['https://push/ok']);
});

test('POST /test mit echtem web-push verbindet nie zu einem Loopback-Endpoint', async () => {
  const db = makeDb();
  const probe = await startProbeListener();
  try {
    const endpoint = `https://127.0.0.1:${probe.port}/internal-probe`;
    const keys = realSubscriptionKeys();
    db.prepare('INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,?,?,?)').run(endpoint, keys.p256dh, keys.auth);
    const app = await startApp(db, realWebpush);
    const res = await fetchRetry(`${app.baseUrl}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const json = await res.json();
    assert.equal(json.data.sent, 0);
    // Kurz Zeit geben, falls ein Connect unterwegs waere.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(probe.connections, 0, 'der Server darf den Loopback-Listener nie erreichen');
  } finally {
    await probe.close();
  }
});

test('der Versand laeuft ueber einen Agent mit SSRF-Lookup und mit Timeout', async () => {
  const db = makeDb();
  const seen = [];
  const webpush = {
    ...makeWebpushMock(),
    sendNotification: async (sub, payload, options) => { seen.push(options); return { statusCode: 201 }; },
  };
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push.example.com/x','p','a')").run();
  // DNS-Antwort ohne Netz: der Name zeigt ins LAN.
  const dnsLookup = (host, opts, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]);
  const svc = createPushService({ db, webpush, dnsLookup });
  await svc.sendPushToUser(1, { title: 't' });
  assert.equal(seen.length, 1);
  const options = seen[0];
  assert.ok(options && options.agent instanceof https.Agent, 'web-push bekommt einen eigenen https.Agent');
  assert.equal(typeof options.timeout, 'number');
  assert.ok(options.timeout > 0 && options.timeout <= 30_000);
  const err = await new Promise((resolve) => {
    options.agent.options.lookup('push.example.com', {}, (e) => resolve(e));
  });
  assert.equal(err?.name, 'BlockedAddressError', 'eine private DNS-Antwort wird beim Verbindungsaufbau abgewiesen');
});

test('ein Name, der ins eigene Netz aufloest, erreicht den Listener mit echtem web-push nicht', async () => {
  const db = makeDb();
  const probe = await startProbeListener();
  try {
    const keys = realSubscriptionKeys();
    db.prepare('INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,?,?,?)')
      .run(`https://push.invalid:${probe.port}/x`, keys.p256dh, keys.auth);
    const dnsLookup = (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    const svc = createPushService({ db, webpush: realWebpush, dnsLookup });
    const sent = await svc.sendPushToUser(1, { title: 't' });
    assert.equal(sent, 0);
    assert.equal(probe.connections, 0);
  } finally {
    await probe.close();
  }
});

test('ein schweigendes Ziel haelt den Versand nicht auf (Frist)', { timeout: 5_000 }, async () => {
  const db = makeDb();
  const webpush = { ...makeWebpushMock(), sendNotification: () => new Promise(() => {}) };
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push.example.com/hang','p','a')").run();
  const svc = createPushService({ db, webpush, timeoutMs: 300 });
  const started = Date.now();
  const sent = await svc.sendPushToUser(1, { title: 't' });
  assert.equal(sent, 0);
  assert.ok(Date.now() - started < 3_000);
});

test('die Standardfrist des Versands ist endlich und knapp', async () => {
  const { PUSH_SEND_TIMEOUT_MS } = await import('../server/services/push.js');
  assert.equal(typeof PUSH_SEND_TIMEOUT_MS, 'number');
  assert.ok(PUSH_SEND_TIMEOUT_MS > 0 && PUSH_SEND_TIMEOUT_MS <= 30_000);
});
