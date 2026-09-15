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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
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

// --- env-Vorrang ist sichtbar, nicht nur wahr ------------------------------
//
// `resolve()` liess env schon immer über die Datenbank gewinnen. Die
// Settings-Seite wusste davon nichts: sie zeigte Eingabefelder, speicherte in
// die Datenbank, und der Wert wirkte nie - ohne Hinweis. Bei WEBDAV_BACKUP_*
// und DOCUMENT_STORAGE_WEBDAV_* war dasselbe Verhalten längst sichtbar gelöst.

import { readFileSync } from 'node:fs';

/** Die Felder, für die es überhaupt eine Umgebungsvariable gibt - aus der Quelle gelesen. */
function envBackedFields() {
  const src = readFileSync(new URL('../server/services/email.js', import.meta.url), 'utf8');
  const block = src.match(/const CONFIG_KEYS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'CONFIG_KEYS in services/email.js nicht gefunden');
  return [...block[1].matchAll(/^\s*(\w+):\s*\{/gm)].map(m => m[1]);
}

test('getPublicConfig meldet env-Kontrolle pro Feld, nicht pro Gruppe', () => {
  const db = makeDb();
  setCfg(db, { email_smtp_host: 'db.host', email_smtp_user: 'db-user' });
  const svc = createEmailService({
    db, nodemailer: makeNodemailerMock(), env: { EMAIL_SMTP_HOST: 'env.host' },
  });
  const pub = svc.getPublicConfig();
  assert.equal(pub.envControlled.host, true, 'gesetzte Variable muss als kontrolliert gelten');
  assert.equal(pub.envControlled.user, false, 'ungesetzte Variable darf das Feld nicht sperren');
  assert.equal(pub.host, 'env.host', 'env gewinnt weiterhin über die Datenbank');
  assert.equal(pub.user, 'db-user', 'freie Felder kommen weiter aus der Datenbank');
});

test('eine leere Umgebungsvariable sperrt nichts', () => {
  const db = makeDb();
  const svc = createEmailService({
    db, nodemailer: makeNodemailerMock(), env: { EMAIL_SMTP_HOST: '   ' },
  });
  assert.equal(svc.getPublicConfig().envControlled.host, false);
});

test('jedes env-gestützte Feld wird gemeldet - keine Feldliste, die driften kann', () => {
  const db = makeDb();
  const svc = createEmailService({ db, nodemailer: makeNodemailerMock(), env: {} });
  const reported = Object.keys(svc.getPublicConfig().envControlled).sort();
  assert.deepEqual(reported, envBackedFields().sort(),
    'envControlled muss genau die Felder abdecken, für die CONFIG_KEYS eine Variable kennt');
});

test('PUT /config schreibt ein env-gesteuertes Feld NICHT in die Datenbank', async () => {
  // Gespeichert wäre der Wert eine Zeitbombe: er würde in dem Moment aktiv, in
  // dem jemand die Umgebungsvariable entfernt.
  const db = makeDb();
  const svc = createEmailService({
    db, nodemailer: makeNodemailerMock(),
    env: { EMAIL_SMTP_HOST: 'env.host', EMAIL_SMTP_PASS: 'env-pass' },
  });
  const app = makeRouteApp(db, svc);
  const { status } = await call(app, 'PUT', '/email/config', {
    host: 'ui.host', user: 'ui-user', pass: 'ui-pass', fromAddress: 'a@test',
  });
  assert.equal(status, 200);
  const row = key => db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value;
  assert.equal(row('email_smtp_host'), undefined, 'gesperrtes Feld darf nicht gespeichert werden');
  assert.equal(row('email_smtp_pass'), undefined, 'gesperrtes Passwort darf nicht gespeichert werden');
  assert.equal(row('email_smtp_user'), 'ui-user', 'freie Felder werden weiterhin gespeichert');
});

test('clearPassword löscht nichts, solange EMAIL_SMTP_PASS gesetzt ist', async () => {
  const db = makeDb();
  setCfg(db, { email_smtp_pass: 'db-pass' });
  const svc = createEmailService({
    db, nodemailer: makeNodemailerMock(), env: { EMAIL_SMTP_PASS: 'env-pass' },
  });
  const app = makeRouteApp(db, svc);
  await call(app, 'PUT', '/email/config', { clearPassword: true });
  assert.equal(
    db.prepare('SELECT value FROM sync_config WHERE key = ?').get('email_smtp_pass')?.value,
    'db-pass',
    'ein gesperrtes Feld darf auch nicht geleert werden'
  );
});

test('die Settings-Seite sperrt jedes env-gestützte Feld sichtbar', () => {
  // Regel statt Allowlist: kommt in CONFIG_KEYS ein Feld dazu, muss die Seite
  // nachziehen. Genau diese Prüfrichtung fehlte und liess SMTP als einzige
  // Gruppe ohne env-Erkennung zurück.
  const page = readFileSync(new URL('../public/settings/pages/admin-email.js', import.meta.url), 'utf8');
  for (const field of envBackedFields()) {
    assert.match(page, new RegExp(`data-env-hint="${field}"`),
      `admin-email.js fehlt der Hinweis für das env-gesteuerte Feld ${field}`);
    assert.match(page, new RegExp(`^\\s*${field}: '[a-z-]+',`, 'm'),
      `admin-email.js fehlt die FIELD_IDS-Zuordnung für ${field}`);
  }
  assert.match(page, /input\.disabled = controlled/,
    'admin-email.js muss die gesteuerten Felder tatsächlich sperren');
});

test('ein SMTP-Passwort behaelt Leerzeichen am Rand, Host und Co. werden getrimmt', () => {
  // Dieselbe Falle wie bei den WebDAV-Zugangsdaten: getrimmt wird geprueft,
  // zurueckgegeben aber nur dort, wo Trimmen unschaedlich ist. Bei Host und
  // Adressen ist ein versehentliches Leerzeichen der wahrscheinlichere Fall,
  // beim Passwort ist es Teil des Werts.
  const db = { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) };
  const svc = createEmailService({
    db,
    env: {
      EMAIL_SMTP_HOST: ' smtp.example.test ',
      EMAIL_SMTP_PASS: ' geheim ',
      EMAIL_FROM_ADDRESS: ' family@example.test ',
    },
  });
  const cfg = svc.getPublicConfig();
  assert.equal(cfg.host, 'smtp.example.test', 'der Host wird getrimmt');
  assert.equal(cfg.fromAddress, 'family@example.test', 'die Absenderadresse wird getrimmt');
  // getPublicConfig gibt das Passwort nie heraus; getRawConfig ist die Stelle,
  // die der Versand tatsaechlich benutzt. Kein optionaler Aufruf: ein Guard,
  // der still ueberspringt, wenn die Methode fehlt, bewacht nichts.
  assert.equal(typeof svc.getRawConfig, 'function', 'getRawConfig muss existieren');
  assert.equal(svc.getRawConfig().pass, ' geheim ', 'das Passwort muss unveraendert bleiben');
});
