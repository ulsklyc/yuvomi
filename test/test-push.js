/**
 * Modul: Push-Test
 * Zweck: VAPID-Auflösung, Subscribe/Unsubscribe-Routen, Versand, Scheduler.
 * Ausführen: node --experimental-sqlite test/test-push.js
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', family_role TEXT, schedule_reminder_offset_minutes INTEGER);
    CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT);
    -- Zweite Rechte-Achse des Vorrats-Voll-Syncs (#467).
    CREATE TABLE access_permissions (
      subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL, access TEXT NOT NULL,
      PRIMARY KEY (subject_type, subject_id, resource_type, resource_key));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE calendar_events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
    CREATE TABLE budget_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      amount REAL, currency TEXT, next_payment_date TEXT);
    CREATE TABLE inventory_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      purchase_date TEXT, warranty_months INTEGER);
    CREATE TABLE inventory_item_dates (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
      label TEXT NOT NULL, date TEXT NOT NULL);
    CREATE TABLE pantry_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1, expires_on TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
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
      entity_type TEXT NOT NULL CHECK(entity_type IN ('task','event','subscription','inventory_item','inventory_tracked_date','pantry_item','cycle_period','cycle_log_nudge','schedule_entry','schedule_extra_entry')),
      entity_id INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
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
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });

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
