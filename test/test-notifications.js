/**
 * Modul: Notification-Channel-Test
 * Zweck: Gotify/ntfy Kanalverwaltung, Provider-Mapping, Reminder-Fan-out und Admin-Routen.
 * Ausführen: node --experimental-sqlite test/test-notifications.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { MIGRATIONS } from '../server/db.js';

function notificationMigration() {
  return MIGRATIONS.find((m) => m.version === 60);
}

function makeDb({ withNotificationTables = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'member'
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL
    );
    CREATE TABLE budget_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL,
      currency TEXT,
      next_payment_date TEXT
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('task','event','subscription')),
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
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_used_at TEXT
    );
  `);
  if (withNotificationTables) {
    db.exec(notificationMigration().up);
  }
  db.prepare("INSERT INTO users (id, username, role) VALUES (1, 'alice', 'admin'), (2, 'bob', 'member')").run();
  return db;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function indexExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}

function pastIso() {
  return new Date(Date.now() - 60_000).toISOString();
}

function futureIso() {
  return new Date(Date.now() + 3_600_000).toISOString();
}

async function call(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  await new Promise((resolve) => server.close(resolve));
  return { status: res.status, json };
}

test('migration 60 creates notification tables and indexes', () => {
  const db = makeDb({ withNotificationTables: false });
  const migration = notificationMigration();
  assert.equal(migration?.version, 60);
  db.exec(migration.up);
  assert.equal(tableExists(db, 'notification_channels'), true);
  assert.equal(tableExists(db, 'notification_deliveries'), true);
  assert.equal(indexExists(db, 'idx_notification_channels_provider'), true);
  assert.equal(indexExists(db, 'idx_notification_deliveries_retry'), true);
});

test('channel store serializes public data without secrets', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  const created = store.createChannel({
    provider: 'gotify',
    name: 'Household Gotify',
    enabled: true,
    config: { baseUrl: 'https://gotify.example.test', priority: 5 },
    secrets: { appToken: 'secret-token' },
  });
  assert.equal(created.provider, 'gotify');
  assert.equal(created.enabled, true);
  assert.deepEqual(created.config, { baseUrl: 'https://gotify.example.test', priority: 5 });
  assert.equal(created.secrets, undefined);
  assert.equal(created.secretSet, true);
});

test('channel store validates providers, URLs, and required secrets', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });
  assert.throws(() => store.createChannel({ provider: 'gotify', name: 'Bad', config: {}, secrets: { appToken: 'x' } }), /base URL/i);
  assert.throws(() => store.createChannel({ provider: 'gotify', name: 'Bad', config: { baseUrl: 'https://gotify.test' }, secrets: {} }), /app token/i);
  assert.throws(() => store.createChannel({ provider: 'ntfy', name: 'Bad', config: { baseUrl: 'https://ntfy.test' }, secrets: {} }), /topic/i);
  assert.throws(() => store.createChannel({ provider: 'ntfy', name: 'Bad', config: { baseUrl: 'https://ntfy.test', topic: 'family', authType: 'token' }, secrets: {} }), /token/i);
  assert.throws(() => store.createChannel({ provider: 'gotify', name: 'Bad', config: { baseUrl: 'file:///tmp/x' }, secrets: { appToken: 'x' } }), /scheme/i);
  assert.throws(() => store.createChannel({ provider: 'webhook', name: 'Bad', config: { baseUrl: 'javascript:alert(1)' } }), /scheme/i);
  assert.throws(() => store.createChannel({ provider: 'smtp', name: 'Bad', config: {}, secrets: {} }), /provider/i);
});

test('channel updates preserve secrets when omitted and clear them explicitly', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  const created = store.createChannel({
    provider: 'ntfy',
    name: 'ntfy',
    enabled: true,
    config: { baseUrl: 'https://ntfy.example.test', topic: 'family', authType: 'token' },
    secrets: { token: 'keep-token' },
  });
  store.updateChannel(created.id, { name: 'ntfy renamed', config: { priority: 'high' } });
  const kept = db.prepare('SELECT secret_json FROM notification_channels WHERE id = ?').get(created.id);
  assert.deepEqual(JSON.parse(kept.secret_json), { token: 'keep-token', username: '', password: '' });

  store.updateChannel(created.id, { clearSecrets: ['token'], config: { authType: 'none' } });
  const cleared = db.prepare('SELECT secret_json FROM notification_channels WHERE id = ?').get(created.id);
  assert.equal(JSON.parse(cleared.secret_json).token, '');
});

test('gotify provider maps reminder payload to Gotify request', async () => {
  const { gotifyProvider } = await import('../server/services/notification-providers/gotify.js');
  const calls = [];
  const result = await gotifyProvider.send({
    channel: {
      config: { baseUrl: 'https://gotify.example.test', priority: 5 },
      secrets: { appToken: 'secret-token' },
    },
    payload: { title: 'Yuvomi', body: 'Müll rausbringen', url: '/reminders' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ id: 7 }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://gotify.example.test/message?token=secret-token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body.get('title'), 'Yuvomi');
  assert.equal(calls[0].options.body.get('message'), 'Müll rausbringen');
  assert.equal(calls[0].options.body.get('priority'), '5');
  assert.match(calls[0].options.body.get('extras'), /client::notification/);
});

test('ntfy provider maps reminder payload with bearer auth', async () => {
  const { ntfyProvider } = await import('../server/services/notification-providers/ntfy.js');
  const calls = [];
  await ntfyProvider.send({
    channel: {
      config: { baseUrl: 'https://ntfy.example.test', topic: 'family-reminders', priority: 'default', authType: 'token' },
      secrets: { token: 'token-value' },
    },
    payload: { title: 'Yuvomi', body: 'Müll rausbringen', url: '/reminders' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => 'ok' };
    },
  });
  assert.equal(calls[0].url, 'https://ntfy.example.test/family-reminders');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Title, 'Yuvomi');
  assert.equal(calls[0].options.headers.Priority, 'default');
  assert.equal(calls[0].options.headers.Click, '/reminders');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-value');
  assert.equal(calls[0].options.body, 'Müll rausbringen');
});

test('webhook provider posts a JSON notification with optional bearer auth', async () => {
  const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
  const calls = [];
  await webhookProvider.send({
    channel: {
      config: { baseUrl: 'https://hooks.example.test/yuvomi' },
      secrets: { token: 'hook-secret' },
    },
    payload: { title: 'Yuvomi', body: 'Task', url: '/reminders', tag: 'reminder-1', priority: 'default' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 204 };
    },
  });
  assert.equal(calls[0].url, 'https://hooks.example.test/yuvomi');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer hook-secret');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.event, 'notification');
  assert.equal(body.notification.body, 'Task');
  assert.match(body.sentAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('providers throw sanitized HTTP errors', async () => {
  const { gotifyProvider } = await import('../server/services/notification-providers/gotify.js');
  await assert.rejects(() => gotifyProvider.send({
    channel: {
      config: { baseUrl: 'https://gotify.example.test', priority: 5 },
      secrets: { appToken: 'secret-token' },
    },
    payload: { title: 'Yuvomi', body: 'Body', url: '/reminders' },
    fetchImpl: async () => ({ ok: false, status: 403 }),
  }), (err) => {
    assert.match(err.message, /authentication/i);
    assert.doesNotMatch(err.message, /secret-token/);
    return true;
  });
});

test('notification processor fans out and deduplicates reminder deliveries', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'gotify', name: 'Gotify', enabled: true, config: { baseUrl: 'https://gotify.test' }, secrets: { appToken: 'g' } });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO tasks (id, title, created_by) VALUES (1, 'Müll rausbringen', 1)").run();
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (1, 'https://push/ok', 'p', 'a')").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'task', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const calls = { webpush: 0, gotify: 0, ntfy: 0 };
  const providers = {
    gotify: { id: 'gotify', send: async () => { calls.gotify += 1; return { ok: true, status: 200 }; } },
    ntfy: { id: 'ntfy', send: async () => { calls.ntfy += 1; return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => { calls.webpush += 1; return 1; } };

  const first = await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.deepEqual(first, { due: 1, attempted: 3, sent: 3, failed: 0, skipped: 0 });
  assert.deepEqual(calls, { webpush: 1, gotify: 1, ntfy: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notification_deliveries WHERE status = 'sent'").get().c, 3);
  assert.notEqual(db.prepare('SELECT pushed_at FROM reminders WHERE id = 1').get().pushed_at, null);

  const second = await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(second.due, 0);
  assert.deepEqual(calls, { webpush: 1, gotify: 1, ntfy: 1 });
});

test('subscription reminders carry name, amount and renewal date as body (#581)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO budget_subscriptions (id, name, amount, currency, next_payment_date) VALUES (1, 'Netflix', 12.99, 'EUR', '2026-06-22')").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'subscription', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Netflix - 12.99 EUR - 2026-06-22');
  assert.equal(payloads[0].title, 'Yuvomi');
});

test('subscription reminders degrade to the bare name when amount or date are missing (#581)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO budget_subscriptions (id, name) VALUES (1, 'Netflix')").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'subscription', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Netflix');
});

test('task reminders keep their bare title as body (#581)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO tasks (id, title, created_by) VALUES (1, 'Müll rausbringen', 1)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'task', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Müll rausbringen');
});

test('reminders for deleted entities never send the app name as body (#581)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'task', 999, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.notEqual(payloads[0].body, payloads[0].title);
  assert.equal(payloads[0].body, 'Reminder');
});

test('notification processor retries failed external channels after backoff', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'gotify', name: 'Gotify', enabled: true, config: { baseUrl: 'https://gotify.test' }, secrets: { appToken: 'g' } });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO tasks (id, title, created_by) VALUES (1, 'Task', 1)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'task', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  let ntfyAttempts = 0;
  const providers = {
    gotify: { id: 'gotify', send: async () => ({ ok: true, status: 200 }) },
    ntfy: {
      id: 'ntfy',
      send: async () => {
        ntfyAttempts += 1;
        if (ntfyAttempts === 1) {
          const err = new Error('ntfy returned HTTP 500');
          err.status = 500;
          throw err;
        }
        return { ok: true, status: 200 };
      },
    },
  };
  const pushService = { sendPushToUser: async () => 0 };
  const firstNow = new Date('2026-06-19T10:00:00.000Z');
  const first = await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: firstNow });
  assert.equal(first.failed, 1);
  assert.equal(db.prepare('SELECT pushed_at FROM reminders WHERE id = 1').get().pushed_at, null);
  let ntfyRow = db.prepare("SELECT * FROM notification_deliveries WHERE provider = 'ntfy'").get();
  assert.equal(ntfyRow.status, 'failed');
  assert.equal(ntfyRow.attempt_count, 1);
  assert.equal(ntfyRow.next_attempt_at > firstNow.toISOString(), true);

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date('2026-06-19T10:02:00.000Z') });
  assert.equal(ntfyAttempts, 1);

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date('2026-06-19T10:06:00.000Z') });
  ntfyRow = db.prepare("SELECT * FROM notification_deliveries WHERE provider = 'ntfy'").get();
  assert.equal(ntfyRow.status, 'sent');
  assert.notEqual(db.prepare('SELECT pushed_at FROM reminders WHERE id = 1').get().pushed_at, null);
});

test('admin notification routes manage channels and test sends', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { buildRouter } = await import('../server/routes/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  const sent = [];
  const routeProviders = {
    gotify: { id: 'gotify', send: async ({ payload }) => { sent.push(payload); return { ok: true, status: 200 }; } },
    ntfy: { id: 'ntfy', send: async () => ({ ok: true, status: 200 }) },
    webhook: { id: 'webhook', send: async () => ({ ok: true, status: 204 }) },
  };
  const router = buildRouter({
    database: db,
    channelStore: store,
    notificationService: {
      providers: routeProviders,
      testChannel: async ({ channel, payload }) => {
        await routeProviders[channel.provider].send({ channel, payload });
        return { ok: true };
      },
    },
  });
  const makeApp = (authRole = 'admin') => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.authUserId = 1; req.authRole = authRole; next(); });
    app.use('/notifications', router);
    return app;
  };
  assert.equal((await call(makeApp('member'), 'GET', '/notifications/channels')).status, 403);

  const providers = await call(makeApp(), 'GET', '/notifications/providers');
  assert.equal(providers.status, 200);
  assert.deepEqual(providers.json.data.map((p) => p.id), ['gotify', 'ntfy', 'webhook']);

  const created = await call(makeApp(), 'POST', '/notifications/channels', {
    provider: 'gotify',
    name: 'Gotify',
    enabled: true,
    config: { baseUrl: 'https://gotify.test' },
    secrets: { appToken: 'secret' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.secretSet, true);
  assert.equal(created.json.data.secrets, undefined);

  const updated = await call(makeApp(), 'PUT', `/notifications/channels/${created.json.data.id}`, {
    name: 'Gotify renamed',
    config: { priority: 7 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.config.priority, 7);
  assert.equal(JSON.parse(db.prepare('SELECT secret_json FROM notification_channels WHERE id = ?').get(created.json.data.id).secret_json).appToken, 'secret');

  const testSend = await call(makeApp(), 'POST', `/notifications/channels/${created.json.data.id}/test`, {});
  assert.equal(testSend.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Yuvomi/);

  const deleted = await call(makeApp(), 'DELETE', `/notifications/channels/${created.json.data.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notification_channels').get().c, 0);
});
