/**
 * Modul: Email-Test
 * Zweck: SMTP-Config-Auflösung (DB + env-Override), Maskierung, Versand, Testmail.
 * Ausführen: node --experimental-sqlite test/test-email.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEmailService } from '../server/services/email.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

function setCfg(db, pairs) {
  const stmt = db.prepare(`INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(pairs)) stmt.run(k, v);
}

// Records createTransport calls + the messages sent through them.
function makeNodemailerMock({ failVerify = false, failSend = false } = {}) {
  const created = [];
  const sent = [];
  return {
    created, sent,
    createTransport(opts) {
      created.push(opts);
      return {
        async verify() { if (failVerify) throw new Error('verify-failed'); return true; },
        async sendMail(msg) {
          if (failSend) throw new Error('send-failed');
          sent.push(msg);
          return { messageId: 'mock-id', accepted: [msg.to] };
        },
      };
    },
  };
}

test('isConfigured is false without host/from, true once both set', () => {
  const db = makeDb();
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  assert.equal(svc.isConfigured(), false);
  setCfg(db, { email_smtp_host: 'smtp.test', email_from_address: 'a@test' });
  assert.equal(svc.isConfigured(), true);
});

test('getPublicConfig never leaks the password and reports passwordSet', () => {
  const db = makeDb();
  setCfg(db, {
    email_smtp_host: 'smtp.test', email_smtp_port: '587', email_smtp_secure: 'starttls',
    email_smtp_user: 'u', email_smtp_pass: 'secret', email_from_address: 'a@test', email_from_name: 'A',
  });
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  const pub = svc.getPublicConfig();
  assert.equal(pub.host, 'smtp.test');
  assert.equal(pub.port, 587);
  assert.equal(pub.secure, 'starttls');
  assert.equal(pub.user, 'u');
  assert.equal(pub.fromAddress, 'a@test');
  assert.equal(pub.passwordSet, true);
  assert.ok(!('pass' in pub), 'password must not be present');
});

test('env override beats DB value', () => {
  const db = makeDb();
  setCfg(db, { email_smtp_host: 'db-host', email_from_address: 'a@test' });
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: { EMAIL_SMTP_HOST: 'env-host' } });
  assert.equal(svc.getPublicConfig().host, 'env-host');
});

test('sendMail builds transport with ssl→secure:true and from header', async () => {
  const db = makeDb();
  setCfg(db, {
    email_smtp_host: 'smtp.test', email_smtp_port: '465', email_smtp_secure: 'ssl',
    email_smtp_user: 'u', email_smtp_pass: 'p', email_from_address: 'box@test', email_from_name: 'Yuvomi',
  });
  const nm = makeNodemailerMock();
  const svc = createEmailService({ db, nodemailer: nm, env: {} });
  await svc.sendMail({ to: 'x@test', subject: 'Hi', text: 'body', html: '<p>body</p>' });
  assert.equal(nm.created[0].secure, true);
  assert.equal(nm.created[0].port, 465);
  assert.deepEqual(nm.created[0].auth, { user: 'u', pass: 'p' });
  assert.equal(nm.sent[0].from, '"Yuvomi" <box@test>');
  assert.equal(nm.sent[0].to, 'x@test');
});

test('starttls maps to secure:false + requireTLS:true', async () => {
  const db = makeDb();
  setCfg(db, { email_smtp_host: 'smtp.test', email_smtp_port: '587', email_smtp_secure: 'starttls', email_from_address: 'a@test' });
  const nm = makeNodemailerMock();
  const svc = createEmailService({ db, nodemailer: nm, env: {} });
  await svc.sendMail({ to: 'x@test', subject: 's', text: 't' });
  assert.equal(nm.created[0].secure, false);
  assert.equal(nm.created[0].requireTLS, true);
});

test('sendMail throws when not configured', async () => {
  const db = makeDb();
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  await assert.rejects(() => svc.sendMail({ to: 'x@test', subject: 's', text: 't' }), /not configured/i);
});

test('sendTest verifies then sends to the given address', async () => {
  const db = makeDb();
  setCfg(db, { email_smtp_host: 'smtp.test', email_smtp_port: '25', email_smtp_secure: 'none', email_from_address: 'a@test' });
  const nm = makeNodemailerMock();
  const svc = createEmailService({ db, nodemailer: nm, env: {} });
  const res = await svc.sendTest('admin@test');
  assert.equal(res.ok, true);
  assert.equal(nm.sent[0].to, 'admin@test');
});

test('sendTest reports failure reason without throwing', async () => {
  const db = makeDb();
  setCfg(db, { email_smtp_host: 'smtp.test', email_smtp_port: '25', email_smtp_secure: 'none', email_from_address: 'a@test' });
  const nm = makeNodemailerMock({ failVerify: true });
  const svc = createEmailService({ db, nodemailer: nm, env: {} });
  const res = await svc.sendTest('admin@test');
  assert.equal(res.ok, false);
  assert.match(res.error, /verify-failed/);
});

// --- Routes ---------------------------------------------------------------
import express from 'express';
import { buildRouter as buildEmailRouter } from '../server/routes/email.js';

function makeRouteApp(db, svc, { userEmail = 'admin@test', authRole = 'admin' } = {}) {
  const app = express();
  app.use(express.json());
  // Stub the auth context the global middleware (requireAuth) would normally set.
  app.use((req, _res, next) => { req.authUserId = 1; req.authRole = authRole; next(); });
  app.use('/email', buildEmailRouter({
    database: db,
    emailService: svc,
    resolveUserEmail: () => userEmail,
  }));
  return app;
}

async function call(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, json };
}

test('email routes reject non-admin users (gate reads req.authRole)', async () => {
  const db = makeDb();
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  const app = makeRouteApp(db, svc, { authRole: 'member' });
  assert.equal((await call(app, 'GET', '/email/config')).status, 403);
  assert.equal((await call(app, 'PUT', '/email/config', { host: 'x', fromAddress: 'a@b' })).status, 403);
  assert.equal((await call(app, 'POST', '/email/test', {})).status, 403);
});

test('GET /config returns masked public config', async () => {
  const db = makeDb();
  setCfg(db, { email_smtp_host: 'smtp.test', email_from_address: 'a@test', email_smtp_pass: 's' });
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  const app = makeRouteApp(db, svc);
  const { status, json } = await call(app, 'GET', '/email/config');
  assert.equal(status, 200);
  assert.equal(json.data.host, 'smtp.test');
  assert.equal(json.data.passwordSet, true);
  assert.ok(!('pass' in json.data));
});

test('PUT /config persists fields and keeps existing password when pass omitted', async () => {
  const db = makeDb();
  setCfg(db, { email_smtp_pass: 'keepme' });
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  const app = makeRouteApp(db, svc);
  const { status } = await call(app, 'PUT', '/email/config', {
    host: 'smtp.new', port: 587, secure: 'starttls', user: 'u', fromAddress: 'a@test', fromName: 'A',
  });
  assert.equal(status, 200);
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='email_smtp_host'").get().value, 'smtp.new');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='email_smtp_pass'").get().value, 'keepme');
});

test('PUT /config sets a new password when provided', async () => {
  const db = makeDb();
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  const app = makeRouteApp(db, svc);
  await call(app, 'PUT', '/email/config', { host: 'smtp.test', fromAddress: 'a@test', pass: 'newpass' });
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='email_smtp_pass'").get().value, 'newpass');
});

test('PUT /config rejects invalid secure value', async () => {
  const db = makeDb();
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  const app = makeRouteApp(db, svc);
  const { status } = await call(app, 'PUT', '/email/config', { host: 'smtp.test', fromAddress: 'a@test', secure: 'bogus' });
  assert.equal(status, 400);
});

test('POST /test sends to the admin email and reports ok', async () => {
  const db = makeDb();
  setCfg(db, { email_smtp_host: 'smtp.test', email_smtp_port: '25', email_smtp_secure: 'none', email_from_address: 'a@test' });
  const nm = makeNodemailerMock();
  const svc = createEmailService({ db, nodemailer: nm, env: {} });
  const app = makeRouteApp(db, svc, { userEmail: 'admin@test' });
  const { status, json } = await call(app, 'POST', '/email/test', {});
  assert.equal(status, 200);
  assert.equal(json.data.ok, true);
  assert.equal(nm.sent[0].to, 'admin@test');
});

test('POST /test returns 400 when no recipient resolvable', async () => {
  const db = makeDb();
  setCfg(db, { email_smtp_host: 'smtp.test', email_from_address: 'a@test' });
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  const app = makeRouteApp(db, svc, { userEmail: null });
  const { status } = await call(app, 'POST', '/email/test', {});
  assert.equal(status, 400);
});
