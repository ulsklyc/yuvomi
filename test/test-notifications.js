/**
 * Modul: Notification-Channel-Test
 * Zweck: Gotify/ntfy Kanalverwaltung, Provider-Mapping, Reminder-Fan-out und Admin-Routen.
 * Ausführen: node --experimental-sqlite test/test-notifications.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
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
      role TEXT NOT NULL DEFAULT 'member',
      -- resolvePermissions() liest das Rollen-Profil ueber family_role.
      family_role TEXT,
      schedule_reminder_offset_minutes INTEGER
    );
    -- Der Vorrats-Voll-Sync fragt beide Rechte-Achsen (#467): sync_config fuer
    -- die haushaltweite Abschaltung, access_permissions je Empfaenger. Fehlt
    -- eine der Tabellen, scheitert er still im try/catch von
    -- processDueNotifications - genau deshalb prueft der Test die WIRKUNG.
    CREATE TABLE IF NOT EXISTS sync_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS access_permissions (
      subject_type  TEXT NOT NULL,
      subject_id    TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_key  TEXT NOT NULL,
      access        TEXT NOT NULL,
      PRIMARY KEY (subject_type, subject_id, resource_type, resource_key)
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
    CREATE TABLE inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      purchase_date TEXT,
      warranty_months INTEGER
    );
    CREATE TABLE inventory_item_dates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      date TEXT NOT NULL,
      reminder_offset_days INTEGER NOT NULL DEFAULT 30
    );
    CREATE TABLE pantry_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      expires_on TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    -- Minimal, wie inventory_items/pantry_items daneben: nur genug Spalten,
    -- damit die CASE-Zweige in processDueNotifications() und der
    -- Schichtplan-Sync (server/services/schedule-reminders.js) sich preparen
    -- lassen. schedule_reminder_offset_minutes sitzt auf users, nicht hier.
    CREATE TABLE schedule_shift_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT
    );
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
      entity_type TEXT NOT NULL CHECK(entity_type IN ('task','event','subscription','inventory_item','inventory_tracked_date','pantry_item','cycle_period','cycle_log_nudge','schedule_entry','schedule_extra_entry','waste_pickup')),
      entity_id INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    -- Minimal, wie inventory_items/pantry_items daneben: nur genug Spalten,
    -- damit die CASE-Zweige fuer cycle_period/cycle_log_nudge sich preparen
    -- lassen (processDueNotifications() referenziert JEDEN entity_type-Zweig
    -- beim .prepare(), unabhaengig davon, ob eine Zeile ihn trifft).
    CREATE TABLE cycle_reminder_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      anchor_date TEXT NOT NULL,
      kind TEXT NOT NULL
    );
    -- Same reasoning as cycle_reminder_anchors above: minimal, just enough for
    -- the waste_pickup CASE branches (entity_title/waste_type_id/waste_date_key)
    -- to prepare.
    CREATE TABLE waste_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE waste_reminder_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type_id INTEGER NOT NULL REFERENCES waste_types(id) ON DELETE CASCADE,
      date_key TEXT NOT NULL
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

test('webhook payload template shapes the body for services with their own schema (#692)', async () => {
  const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
  const calls = [];
  await webhookProvider.send({
    channel: {
      config: {
        baseUrl: 'https://discord.test/api/webhooks/1/abc',
        payloadTemplate: '{"content": "{{title}} - {{body}}", "url": "{{url}}"}',
      },
      secrets: {},
    },
    payload: { title: 'Yuvomi', body: 'Müll rausbringen', url: '/tasks', tag: 'reminder-1' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; },
  });

  // Discord verlangt `content`; der Standardbody kaeme als 400 zurueck.
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    content: 'Yuvomi - Müll rausbringen',
    url: '/tasks',
  });
});

test('webhook template escapes values instead of breaking the JSON around them (#692)', async () => {
  // Der eigentliche Grund fuer JSON.stringify beim Einsetzen: ein Titel mit
  // Anfuehrungszeichen oder Zeilenumbruch zerrisse eine naive Ersetzung, und zwar
  // erst bei der Zustellung - der Empfaenger sieht nur ein 400.
  const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
  const calls = [];
  await webhookProvider.send({
    channel: {
      config: { baseUrl: 'https://hooks.test/x', payloadTemplate: '{"content": "{{title}}: {{body}}"}' },
      secrets: {},
    },
    payload: { title: 'Er sagte "hallo"', body: 'Zeile 1\nZeile 2 \\ Ende', url: null, tag: null },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; },
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    content: 'Er sagte "hallo": Zeile 1\nZeile 2 \\ Ende',
  });
});

test('webhook without a template keeps sending the Yuvomi-shaped body (#692)', async () => {
  const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
  const calls = [];
  await webhookProvider.send({
    channel: { config: { baseUrl: 'https://hooks.test/x', payloadTemplate: '' }, secrets: {} },
    payload: { title: 'Yuvomi', body: 'Task' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; },
  });

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.event, 'notification');
  assert.equal(body.notification.body, 'Task');
});

test('channel store rejects a template that would only fail on delivery (#692)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const db = makeDb();
  // `db`, nicht `database`: der Store destrukturiert { db }. Mit dem falschen
  // Schluessel faellt er still auf die globale Verbindung zurueck und der Test
  // prueft eine andere Datenbank als die, die er sich gerade gebaut hat.
  const store = createNotificationChannelStore({ db });
  const base = { provider: 'webhook', name: 'Hook', config: { baseUrl: 'https://hooks.test/x' } };

  // Kein JSON: faellt im Formular auf, nicht nachts um drei.
  assert.throws(
    () => store.createChannel({ ...base, config: { ...base.config, payloadTemplate: '{"content": {{title}}' } }),
    /valid JSON/i,
  );
  // Platzhalter, den niemand fuellen kann - sonst stuende er woertlich im Body.
  assert.throws(
    () => store.createChannel({ ...base, config: { ...base.config, payloadTemplate: '{"content": "{{titel}}"}' } }),
    /\{\{titel\}\}/,
  );
  // Ein Wert mit Anfuehrungszeichen darf die Pruefung nicht durchrutschen lassen:
  // die Probewerte tragen genau diese Zeichen.
  const ok = store.createChannel({ ...base, config: { ...base.config, payloadTemplate: '{"content": "{{title}}"}' } });
  assert.equal(ok.config.payloadTemplate, '{"content": "{{title}}"}');
  // Leer bleibt erlaubt und bedeutet Standardbody.
  const plain = store.createChannel({ ...base, name: 'Plain', config: { baseUrl: 'https://hooks.test/y' } });
  assert.equal(plain.config.payloadTemplate, '');
});

test('ein Platzhalter mit Sonderzeichen wird gemeldet, nicht durchgewinkt (#692)', async () => {
  // Die Pruefung sagt zu, Unbekanntes abzulehnen. Mit einem gemeinsamen \w+ galt
  // diese Zusage nur fuer Wortzeichen: {{task-title}} war fuer Erkennung UND
  // Ersetzung unsichtbar und ging woertlich an den Empfaenger.
  const { unknownTemplatePlaceholders } = await import('../server/services/notification-providers/webhook.js');
  assert.deepEqual(unknownTemplatePlaceholders('{"text":"{{task-title}}"}'), ['task-title']);
  assert.deepEqual(unknownTemplatePlaceholders('{"text":"{{ title }}"}'), [' title ']);
  assert.deepEqual(unknownTemplatePlaceholders('{"text":"{{item.name}}"}'), ['item.name']);
  assert.deepEqual(unknownTemplatePlaceholders('{"text":"{{title}} {{body}}"}'), []);

  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });
  assert.throws(
    () => store.createChannel({
      provider: 'webhook', name: 'Hook',
      config: { baseUrl: 'https://hooks.test/x', payloadTemplate: '{"text":"{{task-title}}"}' },
    }),
    /\{\{task-title\}\}/,
  );
});

test('ein Webhook behaelt den Schraegstrich am Ende seines Endpunkts (#692)', async () => {
  // Bei Gotify/ntfy ist die URL eine Basis, an die der Provider seinen Pfad
  // haengt - da ist der Slash Rauschen. Beim Webhook IST sie der Endpunkt, und
  // ein Empfaenger darf /hooks/x/ von /hooks/x unterscheiden.
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });

  const hook = store.createChannel({
    provider: 'webhook', name: 'Hook', config: { baseUrl: 'https://hooks.test/services/T/B/' },
  });
  assert.equal(hook.config.baseUrl, 'https://hooks.test/services/T/B/');

  const gotify = store.createChannel({
    provider: 'gotify', name: 'G', config: { baseUrl: 'https://gotify.test/' }, secrets: { appToken: 'x' },
  });
  assert.equal(gotify.config.baseUrl, 'https://gotify.test', 'die Basis behaelt ihr bisheriges Verhalten');
});

test('die OpenAPI-Provider-Liste kennt jeden angebotenen Kanal (#692)', async () => {
  // Der Provider stand in NOTIFICATION_PROVIDERS, aber nicht im Schema: ein
  // generierter Client haette provider:"webhook" abgelehnt, bevor er ihn sendet.
  // Als Regel formuliert, nicht als Liste - der naechste Provider faellt sonst
  // in dieselbe Luecke.
  const { NOTIFICATION_PROVIDERS } = await import('../server/services/notification-channels.js');
  const source = readFileSync(new URL('../server/openapi/schemas.js', import.meta.url), 'utf8');
  // Nur die beiden Notification-Schemata: `provider` gibt es auch im DMS-Schema,
  // und das kennt paperless/papra, nicht gotify.
  const enums = ['NotificationChannel', 'NotificationChannelInput'].map((name) => {
    const at = source.indexOf(`        ${name}: {`);
    assert.ok(at !== -1, `Schema ${name} muss es geben`);
    const block = source.slice(at, at + 2000);
    const m = /provider: \{ type: 'string', enum: \[([^\]]+)\] \}/.exec(block);
    assert.ok(m, `${name} muss ein provider-Enum tragen`);
    return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  });
  for (const values of enums) {
    for (const { id } of NOTIFICATION_PROVIDERS) {
      assert.ok(values.includes(id), `OpenAPI-Enum kennt "${id}" nicht: ${values.join(', ')}`);
    }
  }
});

// --------------------------------------------------------------------------
// SSRF-Schutz der Kanaele (GHSA-f4w5-ggcc-7m5c)
// --------------------------------------------------------------------------
// Webhook, Gotify und ntfy riefen das nackte fetch() auf die eingetragene URL.
// Jetzt laeuft der Aufruf ueber guardedFetch mit dem Anti-Rebinding-Lookup aus
// utils/ssrf.js, und der Store lehnt schon beim Speichern ab, was sich ohne DNS
// entscheiden laesst. NOTIFICATION_ALLOW_PRIVATE_NETWORK=true hebt beides auf.

import http from 'node:http';

function startLocalServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

async function withPrivateNetworkAllowed(fn) {
  const before = process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
  process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK = 'true';
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
    else process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK = before;
  }
}

test('der Store lehnt eine private oder lokale Ziel-URL beim Speichern ab (GHSA-f4w5)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });
  delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
  const blocked = [
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.5:8080/hooks',
    'http://10.0.0.7/',
    'http://127.0.0.1:8080/',
    'http://[::1]:8080/',
    'http://localhost:8080/',
    'http://gotify.local/',
    'http://ha.internal:8123/api/webhook/x',
  ];
  for (const baseUrl of blocked) {
    assert.throws(
      () => store.createChannel({ provider: 'webhook', name: 'Bad', config: { baseUrl } }),
      /private or local network/i,
      `${baseUrl} muss abgelehnt werden`,
    );
  }
  // Dieselbe Regel fuer Gotify und ntfy, und die Fehlermeldung nennt den Schalter.
  assert.throws(
    () => store.createChannel({ provider: 'gotify', name: 'Bad', config: { baseUrl: 'http://192.168.1.5' }, secrets: { appToken: 'x' } }),
    /NOTIFICATION_ALLOW_PRIVATE_NETWORK/,
  );
  assert.throws(
    () => store.createChannel({ provider: 'ntfy', name: 'Bad', config: { baseUrl: 'http://192.168.1.5', topic: 'family' } }),
    /private or local network/i,
  );
  // Ein oeffentlicher Name bleibt speicherbar - die Aufloesung prueft erst der Versand.
  const ok = store.createChannel({ provider: 'webhook', name: 'Ok', config: { baseUrl: 'https://hooks.example.test/x' } });
  assert.ok(ok.id);
  // Und der Schalter oeffnet das LAN bewusst.
  await withPrivateNetworkAllowed(() => {
    const lan = store.createChannel({ provider: 'gotify', name: 'LAN', config: { baseUrl: 'http://192.168.1.5' }, secrets: { appToken: 'x' } });
    assert.equal(lan.config.baseUrl, 'http://192.168.1.5');
  });
});

test('guardedFetch verbindet nur ueber den SSRF-Lookup - ein privates Ziel bleibt unerreicht', async () => {
  const { guardedFetch } = await import('../server/services/notification-providers/guarded-fetch.js');
  const hits = [];
  const { base, close } = await startLocalServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, type: req.headers['content-type'], body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 42 }));
    });
  });
  try {
    delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
    await assert.rejects(() => guardedFetch(`${base}/message`, { method: 'POST', body: 'x' }), /private IP/i);
    assert.equal(hits.length, 0, 'der lokale Server darf nichts empfangen haben');

    await withPrivateNetworkAllowed(async () => {
      const params = new URLSearchParams();
      params.set('title', 'Yuvomi');
      const res = await guardedFetch(`${base}/message`, { method: 'POST', body: params });
      assert.equal(res.ok, true);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { id: 42 });
      assert.equal(hits.length, 1);
      assert.match(hits[0].type, /application\/x-www-form-urlencoded/);
      assert.equal(hits[0].body, 'title=Yuvomi');
    });
  } finally {
    await close();
  }
});

test('ohne fetchImpl senden alle drei Provider ueber guardedFetch (die Voreinstellung ist der Schutz)', async () => {
  const { gotifyProvider } = await import('../server/services/notification-providers/gotify.js');
  const { ntfyProvider } = await import('../server/services/notification-providers/ntfy.js');
  const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
  const { createNotificationService } = await import('../server/services/notifications.js');
  const hits = [];
  const { base, close } = await startLocalServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":1}');
  });
  const payload = { title: 'Yuvomi', body: 'Test', url: '/reminders', tag: 't', priority: 'default' };
  try {
    delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
    await assert.rejects(() => gotifyProvider.send({ channel: { config: { baseUrl: base }, secrets: { appToken: 'x' } }, payload }), /private IP/i);
    await assert.rejects(() => ntfyProvider.send({ channel: { config: { baseUrl: base, topic: 'family' }, secrets: {} }, payload }), /private IP/i);
    await assert.rejects(() => webhookProvider.send({ channel: { config: { baseUrl: `${base}/hook` }, secrets: {} }, payload }), /private IP/i);
    // Auch der Testversand aus den Admin-Routen nimmt die Voreinstellung.
    const service = createNotificationService();
    await assert.rejects(
      () => service.testChannel({ channel: { provider: 'webhook', config: { baseUrl: `${base}/hook` }, secrets: {} }, payload }),
      /private IP/i,
    );
    assert.equal(hits.length, 0, 'kein Provider hat den lokalen Server erreicht');

    await withPrivateNetworkAllowed(async () => {
      const result = await gotifyProvider.send({ channel: { config: { baseUrl: base }, secrets: { appToken: 'x' } }, payload });
      assert.equal(result.ok, true);
      assert.equal(result.providerMessageId, '1');
      await ntfyProvider.send({ channel: { config: { baseUrl: base, topic: 'family' }, secrets: {} }, payload });
      await webhookProvider.send({ channel: { config: { baseUrl: `${base}/hook` }, secrets: {} }, payload });
      assert.deepEqual(hits, ['/message?token=x', '/family', '/hook']);
    });
  } finally {
    await close();
  }
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
  // Der Titel nennt die Herkunft, nicht den App-Namen (Block 2): ein Siegel
  // kann eine Systembenachrichtigung nicht tragen, der Titel schon.
  assert.equal(payloads[0].title, 'Subscriptions');
});

test('a notification names its origin in the title, in the household language', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  // Die Datensprache des Haushalts, wie sie auch der Geburtstags-Titel liest.
  // `sync_config` legt inzwischen makeDb() an - der Vorrats-Voll-Sync liest
  // dort die haushaltweite Modul-Abschaltung.
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('language', 'de')").run();
  db.prepare("INSERT INTO tasks (id, title, created_by) VALUES (1, 'Müll rausbringen', 1)").run();
  db.prepare("INSERT INTO calendar_events (id, title) VALUES (2, 'Zahnarzt')").run();
  db.prepare("INSERT INTO budget_subscriptions (id, name) VALUES (3, 'Netflix')").run();
  for (const [id, type, entity] of [[1, 'task', 1], [2, 'event', 2], [3, 'subscription', 3]]) {
    db.prepare('INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?, 1)')
      .run(id, type, entity, '2026-06-19T09:59:00.000Z');
  }
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });

  const titles = payloads.map((p) => p.title);
  assert.deepEqual(titles, ['Aufgaben', 'Kalender', 'Abonnements'],
    'Jede Meldung nennt ihr Herkunftsmodul im Titel, uebersetzt in die Datensprache des Haushalts.');
  // Und der Body bleibt die Sache selbst - der Titel ersetzt ihn nicht.
  assert.deepEqual(payloads.map((p) => p.body), ['Müll rausbringen', 'Zahnarzt', 'Netflix']);
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

test('inventory warranty reminders carry item name and warranty end as body', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO inventory_items (id, name, purchase_date, warranty_months) VALUES (1, 'Waschmaschine', '2024-07-22', 24)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'inventory_item', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  // Regression: ohne den inventory_item-Zweig im entity_title-CASE kam hier der
  // Fallback-Body 'Reminder' an, also eine Notification ohne jede Sachinfo.
  assert.equal(payloads[0].body, 'Waschmaschine - 2026-07-22');
  // Title-Herkunfts-Regel (v2.6.0): der Titel nennt das Modul, nicht mehr
  // pauschal den App-Namen (vgl. task/event/subscription oben).
  assert.equal(payloads[0].title, 'Inventory');
});

test('inventory warranty reminders degrade to the bare item name without warranty data', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO inventory_items (id, name) VALUES (1, 'Waschmaschine')").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'inventory_item', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Waschmaschine');
});

test('inventory tracked-date reminders carry item name, label and date as body', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO inventory_items (id, name) VALUES (1, 'Auto')").run();
  db.prepare("INSERT INTO inventory_item_dates (id, item_id, label, date, reminder_offset_days) VALUES (1, 1, 'TÜV', '2027-03-01', 30)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'inventory_tracked_date', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  // Regression: ohne den inventory_tracked_date-Zweig im entity_title-CASE kaeme
  // hier der Fallback-Body 'Reminder' an, also eine Notification ohne jede Sachinfo.
  assert.equal(payloads[0].body, 'Auto · TÜV - 2027-03-01');
  // Title-Herkunfts-Regel (v2.6.0): der Titel nennt das Modul, nicht mehr
  // pauschal den App-Namen (vgl. task/event/subscription oben).
  assert.equal(payloads[0].title, 'Inventory');
});

// --------------------------------------------------------------------------
// DER PUSH-LAUF ZIEHT DEN VORRAT NACH
//
// Der Router legt die Erinnerung beim Speichern an - aber ein Vorrat, der schon
// vor #811 im Regal stand, wurde nie gespeichert. Ohne diesen Test prueft nichts,
// dass processDueNotifications den Voll-Sync ueberhaupt AUFRUFT: die Suite in
// test-pantry-expiry-reminders.js ruft ihn selbst auf und bliebe gruen, waehrend
// der Bestand im Betrieb nie meldet.
//
// Der Fehler ist hier zusaetzlich still: der Aufruf steht in try/catch, damit
// eine kaputte Zeile die Zustellung nicht verliert. Genau deshalb muss ein Test
// die WIRKUNG pruefen und nicht das Ausbleiben eines Fehlers - der Voll-Sync
// scheiterte in dieser Suite eine Weile an einer unvollstaendigen Fixture, ohne
// dass ein einziger Haken rot wurde.
// --------------------------------------------------------------------------
test('processDueNotifications legt fehlende Vorrats-Erinnerungen nach', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });

  // Direkt in die Tabelle: die Lage nach einem Update, ohne Router-Schreibweg.
  db.prepare("INSERT INTO pantry_items (id, name, quantity, expires_on, created_by) VALUES (1, 'Marmelade', 2, '2099-06-01', 1)").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE entity_type = 'pantry_item'").get().c, 0);

  await processDueNotifications({ database: db, channelStore: store, pushService: { sendPushToUser: async () => 0 }, providers: {}, now: new Date() });

  const reminder = db.prepare("SELECT * FROM reminders WHERE entity_type = 'pantry_item' AND entity_id = 1").get();
  assert.ok(reminder, 'der Bestand meldet sonst nie - der Lauf legt nichts nach');
  // Sieben Tage vor dem MHD, dieselbe Schwelle wie der Chip in der Liste.
  assert.equal(reminder.remind_at, '2099-05-25T09:00');
});

test('pantry reminders carry the item name and its best-before date as body', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  // FESTES `now`, UND MHD/remind_at PASSEN EXAKT ZUSAMMEN. Beides ist noetig:
  // der Voll-Sync raeumt eine Vorwarnung ab, deren Artikel laengst abgelaufen
  // ist, und er zieht einen abweichenden Termin gerade. Nur wenn
  // `expires_on - 7 Tage` genau dem gesetzten remind_at entspricht, laesst er
  // die Zeile in Ruhe - und dann haengt der Test auch an keiner Wanduhr.
  db.prepare("INSERT INTO pantry_items (id, name, quantity, expires_on, created_by) VALUES (1, 'Joghurt', 2, '2026-08-27', 1)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'pantry_item', 1, ?, 1)")
    .run('2026-08-20T09:00');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date('2026-08-20T10:00:00Z') });
  assert.equal(payloads.length, 1);
  // Regression: ohne den pantry_item-Zweig im entity_title-CASE kaeme hier der
  // Fallback-Body 'Reminder' an - eine Meldung, die nicht sagt, welcher Artikel.
  assert.equal(payloads[0].body, 'Joghurt - 2026-08-27');
  // Herkunfts-Regel: der Titel nennt das Modul, und das Ziel fuehrt dorthin -
  // beides steht in EINEM Eintrag, damit es nicht auseinanderlaufen kann.
  assert.equal(payloads[0].title, 'Pantry');
  assert.equal(payloads[0].url, '/pantry');
});

test('eine Vorrats-Erinnerung ohne Artikel wird abgeraeumt statt inhaltslos zugestellt', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  // Zeigt auf einen Artikel, den es nicht (mehr) gibt. Der Router raeumt beim
  // Loeschen auf; eine Zeile, die das umgangen hat, faengt der Voll-Sync ab.
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'pantry_item', 99, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });

  // Vorher waere hier eine Meldung mit dem Ersatztext 'Reminder' rausgegangen -
  // eine Unterbrechung, die nicht sagen kann, worum es geht.
  assert.equal(payloads.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE entity_type = 'pantry_item'").get().c, 0);
});

test('inventory tracked-date reminders degrade to the bare title without a date', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO inventory_items (id, name) VALUES (1, 'Auto')").run();
  db.prepare("INSERT INTO inventory_item_dates (id, item_id, label, date, reminder_offset_days) VALUES (1, 1, 'TÜV', '2027-03-01', 30)").run();
  // Reminder zeigt auf eine geloeschte Fristen-Zeile: entity_title bleibt leer,
  // damit greift der generische Fallback statt eines halbfertigen Bodys.
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'inventory_tracked_date', 99, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Reminder');
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

/* ------------------------------------------------------------------ *
 * E-Mail als vierter Kanal (#944)
 *
 * Der Kanal traegt NUR sein Ziel. Der SMTP-Zugang steht app-weit in
 * services/email.js und traegt schon Passwort-Reset und Einladungen; ein
 * zweiter Satz Zugangsdaten je Kanal waere eine zweite Schreibweise fuer
 * dieselbe Sache.
 * ------------------------------------------------------------------ */

function fakeMailer({ configured = true } = {}) {
  const sent = [];
  return {
    sent,
    isConfigured: () => configured,
    sendMail: async (message) => { sent.push(message); return { messageId: 'x' }; },
  };
}

test('ein Mail-Kanal traegt nur sein Ziel - keine Basis-URL, keine Geheimnisse (#944)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  const created = store.createChannel({
    provider: 'email',
    name: 'Oma',
    enabled: true,
    config: { toAddress: '  oma@example.org  ' },
  });
  assert.deepEqual(created.config, { toAddress: 'oma@example.org' }, 'nur die Adresse, getrimmt');
  assert.equal(created.secretSet, false, 'ein Mail-Kanal haelt kein eigenes Geheimnis');
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT secret_json FROM notification_channels WHERE id = ?').get(created.id).secret_json),
    {},
    'und legt auch keines an - sonst waere das SMTP-Passwort an zwei Orten'
  );
});

test('eine unbrauchbare Empfaengeradresse wird beim Speichern abgelehnt, nicht beim Senden (#944)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });
  const reject = (toAddress, why) => assert.throws(
    () => store.createChannel({ provider: 'email', name: 'Bad', config: { toAddress } }),
    /recipient email address/i,
    why
  );
  reject('', 'leer');
  reject('kein-at', 'ohne @');
  reject('a@b', 'ohne Punkt in der Domain');
  reject('a b@c.de', 'mit Leerzeichen');
  // Der teuerste Fall: ein Zeilenumbruch im Empfaenger-Header macht aus einer
  // Adresse zwei Header. Er darf gar nicht erst in die Datenbank.
  reject('a@c.de\nBcc: fremd@example.org', 'mit Zeilenumbruch (Header-Injection)');
  reject('a@c.de\r\nBcc: fremd@example.org', 'mit CRLF (Header-Injection)');
  reject('a@.de', 'Punkt direkt hinter dem @');
  reject('a@de.', 'Punkt am Ende der Domain');
  reject('@example.org', 'nichts vor dem @');
  reject('a@b@c.de', 'zwei @');
  reject(`${'a'.repeat(250)}@example.org`, 'laenger als RFC 5321 erlaubt');
  // Und die Gegenprobe, damit die Pruefung nicht einfach alles ablehnt:
  assert.equal(
    store.createChannel({ provider: 'email', name: 'Ok', config: { toAddress: 'vor.name+tag@sub.example.co.uk' } }).config.toAddress,
    'vor.name+tag@sub.example.co.uk',
    'eine gewoehnliche Adresse mit Punkt, Plus und Subdomain geht durch'
  );
});

test('eine Adressliste wird abgelehnt - ein Kanal, ein Ziel (#944)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });
  // nodemailer liest `to` als LISTE. "a@example.com,postmaster" waeren zwei
  // Empfaenger im Umschlag - die Zusage "eine Adresse je Kanal" waere gebrochen
  // und der Zustellstatus des Kanals truege zwei Wahrheiten. Die Zaehlung der
  // @ allein faengt das nicht: der zweite Eintrag braucht gar keines.
  for (const listy of ['a@example.com,postmaster', 'a@example.com,b@example.com', 'a@example.com;b@example.com']) {
    assert.throws(
      () => store.createChannel({ provider: 'email', name: 'Liste', config: { toAddress: listy } }),
      /email address/i,
      `${listy} muss abgelehnt werden`
    );
  }
});

test('der Betreff einer Erinnerungsmail bleibt aus dem Log (#944)', async () => {
  const { emailProvider } = await import('../server/services/notification-providers/email.js');
  // `emailService.sendMail` schreibt Empfaenger und Betreff auf info. Solange
  // dort nur Passwort-Reset und Einladung liefen, war der Betreff fest. Eine
  // Erinnerung traegt darin den Aufgaben- oder Terminnamen - bei einer
  // Medikamenten-Erinnerung einen Gesundheitsdatensatz, der sonst dauerhaft
  // auf stdout des Containers liegt.
  const mailer = fakeMailer();
  await emailProvider.send({
    channel: { config: { toAddress: 'oma@example.org' } },
    payload: { title: 'Gesundheit', body: 'Metformin 500mg' },
    emailService: mailer,
    env: {},
  });
  const mail = mailer.sent[0];
  assert.match(mail.subject, /Metformin/, 'in der Mail steht er - dafuer ist sie da');
  assert.ok(mail.logLabel, 'aber fuers Log gibt der Aufrufer eine Gattung an');
  assert.doesNotMatch(mail.logLabel, /Metformin/);
  assert.doesNotMatch(mail.logLabel, /Gesundheit/);
});

test('der Mail-Transport gibt vor dem Aufrufer auf (#944)', async () => {
  // Reihenfolge der Zeitschranken, und sie ist der ganze Punkt: gibt der
  // Transport zuerst auf, ist die Verbindung zu und ein erneuter Versuch
  // redlich. Gaebe der Aufrufer zuerst auf, liefe der Versand darunter weiter -
  // die Zustellung gaelte als gescheitert, wuerde wiederholt, und die Mail kaeme
  // womoeglich zweimal an.
  const { createEmailService } = await import('../server/services/email.js');
  const db = makeDb();
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('email_smtp_host', 'smtp.example.test')").run();
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('email_from_address', 'yuvomi@example.test')").run();
  let opts = null;
  const service = createEmailService({
    db,
    env: {},
    nodemailer: { createTransport: (o) => { opts = o; return { sendMail: async () => ({ messageId: 'x' }) }; } },
  });
  await service.sendMail({ to: 'a@b.de', subject: 's', text: 't', html: '<p>t</p>' });

  const { PROVIDER_TIMEOUT_MS } = await import('../server/services/notifications.js');
  for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
    assert.ok(Number.isFinite(opts[key]), `${key} muss gesetzt sein - sonst wartet nodemailer unbegrenzt`);
    assert.ok(opts[key] < PROVIDER_TIMEOUT_MS,
      `${key} (${opts[key]}) muss unter dem Abbruch des Aufrufers (${PROVIDER_TIMEOUT_MS}) liegen`);
  }
});

test('eine pathologische Adresse prallt ab, statt den Server anzuhalten (#944)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });
  // DIE ERSTE FASSUNG PRUEFTE MIT `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Deren beide
  // Teile hinter dem @ ueberlappen sich - `[^\s@]` deckt auch den Punkt -, also
  // probiert die Engine bei einer langen Eingabe OHNE Treffer jede Aufteilung
  // von "Domain.TLD" durch. Sauber quadratisch: 1 kB kostete 1 ms, 8 kB schon
  // 53 ms, die 80 kB hier gut fuenf Sekunden. Node arbeitet einaedrig - der
  // ganze Server steht so lange.
  //
  // DAS SCHLUSS-@ IST DIE POINTE, nicht Beiwerk. Der erste Anlauf haengte ein
  // Leerzeichen an; `trim()` nahm es weg, und was blieb, war eine GUELTIGE
  // Adresse. Der Test wurde damals rot, weil kein Fehler kam - nicht wegen der
  // Zeit. Er haette einen Rueckfall nicht bemerkt. Ein `@` ist von `[^\s@]`
  // ausgeschlossen und ueberlebt das Trimmen, also scheitert der Match wirklich
  // und die Engine backtrackt sich durch die ganze Laenge.
  const evil = `a@${'!.'.repeat(40_000)}@`;
  const started = process.hrtime.bigint();
  assert.throws(() => store.createChannel({ provider: 'email', name: 'Evil', config: { toAddress: evil } }), /email address/i);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // Grosszuegig: die lineare Fassung liegt unter einer Millisekunde, die
  // backtrackende bei dieser Laenge um das Tausendfache darueber. Zwischen
  // beiden ist so viel Platz, dass die Schranke auf keiner Maschine wackelt.
  assert.ok(elapsedMs < 250, `Die Pruefung brauchte ${elapsedMs.toFixed(0)} ms - das riecht nach Backtracking`);
});

test('eine Erinnerungsmail escapet die Nutzerdaten, die sie traegt (#944)', async () => {
  const { emailProvider } = await import('../server/services/notification-providers/email.js');
  const mailer = fakeMailer();
  await emailProvider.send({
    channel: { config: { toAddress: 'oma@example.org' } },
    // Ein Terminname ist Nutzereingabe. In einer HTML-Mail ist er genauso
    // gefaehrlich wie im DOM - manche Clients rendern grosszuegig.
    payload: { title: 'Kalender', body: 'Zahnarzt <img src=x onerror=alert(1)> & Co', url: '/calendar' },
    emailService: mailer,
    env: { BASE_URL: 'https://haus.example' },
  });
  const mail = mailer.sent[0];
  // Als Regel statt als Tag-Name: eine Suche nach `<img` uebersieht `<IMG` und
  // fragt ohnehin nach dem falschen - die Zusicherung ist, dass NUR die Tags
  // vorkommen, die der Provider selbst baut.
  const OWN_TAGS = new Set(['p', 'a']);
  const foreign = [...new Set(
    [...mail.html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()),
  )].filter((tag) => !OWN_TAGS.has(tag));
  assert.deepEqual(foreign, [], `durchgereichtes Markup: ${foreign.join(', ')}`);
  assert.match(mail.html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'sondern escaped');
  assert.match(mail.html, /&amp; Co/, 'auch das kaufmaennische Und');
  assert.match(mail.text, /Zahnarzt <img src=x onerror=alert\(1\)> & Co/, 'die Textfassung bleibt roh');
});

test('der Betreff nennt Herkunft UND Sache - im Posteingang ist nur er sichtbar (#944)', async () => {
  const { emailProvider } = await import('../server/services/notification-providers/email.js');
  const mailer = fakeMailer();
  const send = (payload) => emailProvider.send({
    channel: { config: { toAddress: 'oma@example.org' } }, payload, emailService: mailer, env: {},
  });
  await send({ title: 'Kalender', body: 'Zahnarzt' });
  assert.equal(mailer.sent.at(-1).subject, 'Kalender: Zahnarzt');
  // Gleicher Titel und Body: nicht doppeln.
  await send({ title: 'Yuvomi', body: 'Yuvomi' });
  assert.equal(mailer.sent.at(-1).subject, 'Yuvomi');
  // Ein Zeilenumbruch im Titel darf keinen weiteren Header oeffnen.
  await send({ title: 'Aufgaben', body: 'Milch\nBcc: fremd@example.org' });
  assert.doesNotMatch(mailer.sent.at(-1).subject, /[\r\n]/, 'der Betreff bleibt einzeilig');
});

test('ohne BASE_URL traegt die Mail keinen Link statt eines kaputten (#944)', async () => {
  const { emailProvider } = await import('../server/services/notification-providers/email.js');
  const mailer = fakeMailer();
  const base = { channel: { config: { toAddress: 'oma@example.org' } }, emailService: mailer };
  const payload = { title: 'Kalender', body: 'Zahnarzt', url: '/calendar' };

  await emailProvider.send({ ...base, payload, env: { BASE_URL: 'https://haus.example/' } });
  assert.match(mailer.sent.at(-1).html, /href="https:\/\/haus\.example\/calendar"/, 'der Schraegstrich am Ende verdoppelt sich nicht');
  assert.match(mailer.sent.at(-1).text, /https:\/\/haus\.example\/calendar/);

  // `/calendar` allein ist in einer Mail kein Ziel. Der Request-Host wird hier
  // bewusst nicht herangezogen - beim Versand kommt gar keiner vorbei.
  await emailProvider.send({ ...base, payload, env: {} });
  assert.doesNotMatch(mailer.sent.at(-1).html, /href=/, 'lieber kein Link als ein toter');
  assert.doesNotMatch(mailer.sent.at(-1).text, /calendar/);
});

test('ohne SMTP nennt der Mail-Kanal den Grund, statt still zu scheitern (#944)', async () => {
  const { emailProvider } = await import('../server/services/notification-providers/email.js');
  const mailer = fakeMailer({ configured: false });
  await assert.rejects(
    () => emailProvider.send({ channel: { config: { toAddress: 'a@b.de' } }, payload: { title: 'x', body: 'y' }, emailService: mailer }),
    /SMTP/i,
    'die Meldung muss sagen, was zu tun ist'
  );
  assert.equal(mailer.sent.length, 0);
  assert.equal(emailProvider.isAvailable({ emailService: mailer }), false);
  assert.equal(emailProvider.isAvailable({ emailService: fakeMailer() }), true);
});

test('die Kanalliste meldet einen Anbieter als nicht einsatzbereit, bevor ein Test scheitert (#944)', async () => {
  const { buildRouter } = await import('../server/routes/notifications.js');
  const db = makeDb();
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  // Die Test-Route beantwortet einen Fehlschlag mit generischem "Internal
  // error" - der eine Satz, der weiterhilft, geht dabei verloren. Deshalb muss
  // die Liste den Zustand schon vorher tragen.
  const router = buildRouter({
    database: db,
    channelStore: createNotificationChannelStore({ db }),
    notificationService: {
      providers: {
        gotify: { id: 'gotify', send: async () => ({ ok: true }) },
        email: { id: 'email', isAvailable: () => false, send: async () => ({ ok: true }) },
      },
      testChannel: async () => ({ ok: true }),
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; next(); });
  app.use('/notifications', router);

  const res = await call(app, 'GET', '/notifications/providers');
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.json.data.map((p) => [p.id, p]));
  assert.equal(byId.email.ready, false, 'Mail ohne SMTP ist nicht einsatzbereit');
  assert.equal('ready' in byId.gotify, false, 'wer keine Voraussetzung hat, bleibt unveraendert');
});

test('der Erinnerungslauf stellt ueber einen Mail-Kanal zu (#944)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const { emailProvider } = await import('../server/services/notification-providers/email.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'email', name: 'Oma', enabled: true, config: { toAddress: 'oma@example.org' } });
  db.prepare("INSERT INTO tasks (id, title, created_by) VALUES (1, 'Müll rausbringen', 1)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'task', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const mailer = fakeMailer();
  const providers = {
    email: { id: 'email', send: (args) => emailProvider.send({ ...args, emailService: mailer, env: {} }) },
  };
  const pushService = { sendPushToUser: async () => 0 };

  const first = await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.deepEqual(first, { due: 1, attempted: 1, sent: 1, failed: 0, skipped: 0 });
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'oma@example.org');
  assert.match(mailer.sent[0].subject, /Müll rausbringen/);

  // Zweiter Lauf: dieselbe Erinnerung darf nicht erneut zugestellt werden.
  const second = await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(second.due, 0);
  assert.equal(mailer.sent.length, 1, 'keine zweite Mail fuer dieselbe Erinnerung');
});

// Eigenes Zeitlimit: faellt das Rennen im Provider weg, HAENGT dieser Test
// sonst, statt rot zu werden - und ein haengender Lauf blockiert die CI, statt
// sie zu warnen (dieselbe Falle wie in der caldav-sync-Suite, #903).
test('ein haengender SMTP-Server blockiert den Erinnerungslauf nicht (#944)', { timeout: 5000 }, async () => {
  const { emailProvider } = await import('../server/services/notification-providers/email.js');
  // nodemailer kennt kein AbortSignal. Ohne das Rennen im Provider wartet der
  // Lauf hier ewig - und er arbeitet ALLE faelligen Erinnerungen nacheinander ab.
  const controller = new AbortController();
  const hanging = { isConfigured: () => true, sendMail: () => new Promise(() => {}) };
  const pending = emailProvider.send({
    channel: { config: { toAddress: 'a@b.de' } },
    payload: { title: 'x', body: 'y' },
    emailService: hanging,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(() => pending, /timed out/i);
});
