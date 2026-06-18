/**
 * Modul: Push-Test
 * Zweck: VAPID-Auflösung, Subscribe/Unsubscribe-Routen, Versand, Scheduler.
 * Ausführen: node --experimental-sqlite test/test-push.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { buildRouter } from '../server/routes/push.js';
import { processDuePushes } from '../server/services/push-scheduler.js';

// --- Minimal-Schema -------------------------------------------------------
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL);
    CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE calendar_events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('task','event')),
      entity_id INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
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
  db.prepare("INSERT INTO users (id, username) VALUES (1,'alice'),(2,'bob')").run();
  return db;
}

// --- web-push Mock --------------------------------------------------------
function makeWebpushMock() {
  const calls = [];
  return {
    calls,
    generateVAPIDKeys: () => ({ publicKey: 'PUB_GEN', privateKey: 'PRIV_GEN' }),
    setVapidDetails: () => {},
    sendNotification: async (sub, payload) => {
      calls.push({ endpoint: sub.endpoint, payload });
      if (sub.endpoint.includes('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
      if (sub.endpoint.includes('boom')) { const e = new Error('boom'); e.statusCode = 500; throw e; }
      return { statusCode: 201 };
    },
  };
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

async function startApp(db, webpush, userId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = userId; next(); });
  const { createPushService } = await import('../server/services/push.js');
  const pushService = createPushService({ db, webpush });
  app.use('/', buildRouter({ pushService, database: db }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('GET /vapid-public-key returns the key', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock());
  const res = await fetch(`${app.baseUrl}/vapid-public-key`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.key, 'PUB_GEN');
  await app.close();
});

test('POST /subscribe inserts then upserts the subscription', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock());
  const body = { endpoint: 'https://push/x', keys: { p256dh: 'PP', auth: 'AA' } };
  let res = await fetch(`${app.baseUrl}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 201);
  res = await fetch(`${app.baseUrl}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, keys: { p256dh: 'PP2', auth: 'AA2' } }) });
  assert.equal(res.status, 201);
  const rows = db.prepare('SELECT p256dh FROM push_subscriptions WHERE endpoint = ?').all('https://push/x');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].p256dh, 'PP2');
  await app.close();
});

test('POST /subscribe rejects missing keys', async () => {
  const db = makeDb();
  const app = await startApp(db, makeWebpushMock());
  const res = await fetch(`${app.baseUrl}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://push/x' }) });
  assert.equal(res.status, 400);
  await app.close();
});

test('POST /unsubscribe removes the subscription', async () => {
  const db = makeDb();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/x','p','a')").run();
  const app = await startApp(db, makeWebpushMock());
  const res = await fetch(`${app.baseUrl}/unsubscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://push/x' }) });
  assert.equal(res.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c, 0);
  await app.close();
});

test('POST /test forwards client-provided localized text', async () => {
  const db = makeDb();
  const webpush = makeWebpushMock();
  db.prepare("INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,'https://push/x','p','a')").run();
  const app = await startApp(db, webpush);
  const res = await fetch(`${app.baseUrl}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Titel', body: 'Inhalt' }) });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.sent, 1);
  assert.match(webpush.calls[0].payload, /Titel/);
  await app.close();
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
