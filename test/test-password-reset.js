/**
 * Modul: Password-Reset-Test
 * Zweck: Token-Lebenszyklus (create/verify/consume/cleanup) + Forgot/Reset-Routen.
 * Ausführen: node --experimental-sqlite test/test-password-reset.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPasswordResetService } from '../server/services/password-reset.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT 'x');
    CREATE TABLE password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE UNIQUE INDEX idx_password_resets_hash ON password_resets(token_hash);
  `);
  db.prepare("INSERT INTO users (id, username) VALUES (1,'alice')").run();
  return db;
}

test('createToken stores only the hash, not the raw token', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db });
  const { token } = svc.createToken(1);
  const row = db.prepare('SELECT token_hash FROM password_resets WHERE user_id = 1').get();
  assert.ok(token.length >= 40);
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('verifyToken returns user id for a valid token, null for unknown', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db });
  const { token } = svc.createToken(1);
  assert.equal(svc.verifyToken(token), 1);
  assert.equal(svc.verifyToken('nope'), null);
});

test('verifyToken returns null for an expired token', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db, now: () => 1000 });
  const { token } = svc.createToken(1); // expires at 1000 + 3600_000
  const svcLater = createPasswordResetService({ db, now: () => 1000 + 3_600_001 });
  assert.equal(svcLater.verifyToken(token), null);
});

test('consumeToken removes the row', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db });
  const { token } = svc.createToken(1);
  svc.consumeToken(token);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets').get().c, 0);
});

test('createToken invalidates prior tokens for the same user', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db });
  const first = svc.createToken(1).token;
  svc.createToken(1);
  assert.equal(svc.verifyToken(first), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets WHERE user_id = 1').get().c, 1);
});

test('cleanupExpired deletes only stale rows', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db, now: () => 1000 });
  svc.createToken(1);
  const later = createPasswordResetService({ db, now: () => 1000 + 3_600_001 });
  assert.equal(later.cleanupExpired(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets').get().c, 0);
});

// --- Routes (forgot/reset) ------------------------------------------------
import express from 'express';
import bcrypt from 'bcrypt';

function makeAuthApp(db, { baseUrl = 'https://oikos.test', sendMail = null } = {}) {
  // Lazy import so the route module reads our injected services.
  return import('../server/auth.js').then(({ buildResetRoutes }) => {
    const sent = [];
    const app = express();
    app.use(express.json());
    const router = express.Router();
    const pending = [];
    buildResetRoutes(router, {
      database: db,
      emailService: { isConfigured: () => true, sendMail: sendMail || (async (m) => { sent.push(m); }) },
      resetService: createPasswordResetService({ db }),
      baseUrl,
      limiter: (_req, _res, next) => next(), // bypass rate limiting in tests
      // Der Versand laeuft nach der Antwort (Antwortzeit ist kein Konto-Orakel);
      // `drain` wartet darauf, damit die Tests danach zaehlen koennen.
      defer: (fn) => { pending.push(new Promise((r) => setImmediate(() => Promise.resolve(fn()).finally(r)))); },
    });
    app.use('/auth', router);
    app.locals.drain = () => Promise.all(pending.splice(0));
    return { app, sent };
  });
}

async function callJson(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  server.close();
  await app.locals.drain?.();
  return { status: res.status, json };
}

function seedContactsAndEmail(db) {
  db.exec(`CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT,
    family_user_id INTEGER, email TEXT);`);
  db.prepare("INSERT INTO contacts (family_user_id, email) VALUES (1, 'alice@test')").run();
}

test('forgot-password returns generic ok for unknown user (no email sent)', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app, sent } = await makeAuthApp(db);
  const { status, json } = await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'ghost' });
  assert.equal(status, 200);
  assert.equal(json.data.ok, true);
  assert.equal(sent.length, 0);
});

test('forgot-password sends a reset link for a known username', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app, sent } = await makeAuthApp(db);
  const { status, json } = await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  assert.equal(status, 200);
  assert.equal(json.data.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'alice@test');
  assert.match(sent[0].html, /https:\/\/oikos\.test\/reset-password\?token=[a-f0-9]+/);
});

test('forgot-password sends no link when no trusted BASE_URL is configured (no host-header fallback)', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app, sent } = await makeAuthApp(db, { baseUrl: '' });
  const { status, json } = await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  assert.equal(status, 200);
  assert.equal(json.data.ok, true);
  assert.equal(sent.length, 0);
});

test('forgot-password runs the rate limiter on every request (counts 200 responses)', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  let calls = 0;
  const { buildResetRoutes } = await import('../server/auth.js');
  const app = express();
  app.use(express.json());
  const router = express.Router();
  buildResetRoutes(router, {
    database: db,
    emailService: { isConfigured: () => true, sendMail: async () => {} },
    resetService: createPasswordResetService({ db }),
    baseUrl: 'https://oikos.test',
    limiter: (_req, _res, next) => { calls += 1; next(); },
  });
  app.use('/auth', router);
  // Two known-user requests both return 200 — the limiter must still count both.
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  assert.equal(calls, 2);
});

test('forgot-password also resolves a user by email', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice@test' });
  assert.equal(sent.length, 1);
});

test('forgot-password findet eine gespeicherte Adresse mit Leerraum und anderer Schreibweise', async () => {
  // Dieselbe Normalisierung wie die SSO-Verknuepfung: beide Seiten getrimmt
  // und ohne Gross-/Kleinschreibung verglichen.
  const db = makeDb();
  db.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, family_user_id INTEGER, email TEXT);');
  db.prepare("INSERT INTO contacts (family_user_id, email) VALUES (1, '  Alice@Test ')").run();
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice@test' });
  assert.equal(sent.length, 1, 'die Adresse mit Leerraum findet das Konto');
});

test('forgot-password schickt bei mehrdeutiger Adresse an niemanden und antwortet gleich', async () => {
  // Zwei Konten fuehren nach der Normalisierung dieselbe Adresse. Wie bei der
  // SSO-Verknuepfung zaehlt nur GENAU EIN Treffer - vorher ging der Link per
  // LIMIT 1 an irgendeines der beiden.
  const db = makeDb();
  db.prepare("INSERT INTO users (id, username) VALUES (2,'bob')").run();
  db.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, family_user_id INTEGER, email TEXT);');
  db.prepare("INSERT INTO contacts (family_user_id, email) VALUES (1, 'shared@test')").run();
  db.prepare("INSERT INTO contacts (family_user_id, email) VALUES (2, 'Shared@Test ')").run();
  const { app, sent } = await makeAuthApp(db);
  const res = await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'shared@test' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { data: { ok: true } }, 'dieselbe Antwort wie bei jedem anderen Ausgang');
  assert.equal(sent.length, 0, 'kein Link an ein beliebiges der beiden Konten');
});

test('forgot-password findet eine Adresse mit Tab, CR oder NBSP', async () => {
  for (const stored of ['\talice@test\r', '\u00a0Alice@Test\u00a0']) {
    const db = makeDb();
    db.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, family_user_id INTEGER, email TEXT);');
    db.prepare('INSERT INTO contacts (family_user_id, email) VALUES (1, ?)').run(stored);
    const { app, sent } = await makeAuthApp(db);
    await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice@test' });
    assert.equal(sent.length, 1, `gespeichert als ${JSON.stringify(stored)}`);
  }
});

function makeDbWithGuest({ guestEmail, memberEmail }) {
  const db = makeDb();
  db.prepare("INSERT INTO users (id, username) VALUES (2,'gast')").run();
  db.exec(`CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, family_user_id INTEGER, email TEXT);
    CREATE TABLE split_expense_guest_users (user_id INTEGER PRIMARY KEY);`);
  db.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (2)').run();
  if (memberEmail) db.prepare('INSERT INTO contacts (family_user_id, email) VALUES (1, ?)').run(memberEmail);
  db.prepare('INSERT INTO contacts (family_user_id, email) VALUES (2, ?)').run(guestEmail);
  return db;
}

test('forgot-password: ein Gastkonto aus den geteilten Ausgaben macht die Adresse nicht mehrdeutig', async () => {
  // Ein Gast entsteht aus einem beliebigen Kontakt; fuehrt der zufaellig
  // dieselbe Adresse wie ein Mitglied, sperrte er sonst dessen Reset.
  const db = makeDbWithGuest({ memberEmail: 'alice@test', guestEmail: 'Alice@Test' });
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice@test' });
  assert.equal(sent.length, 1, 'das Mitglied bekommt seinen Link');
});

test('forgot-password: ein Gast allein wird ueber seine Adresse weiterhin gefunden', async () => {
  const db = makeDbWithGuest({ guestEmail: 'gast@test' });
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'gast@test' });
  assert.equal(sent.length, 1);
});

test('forgot-password antwortet, bevor der Versand fertig ist, und in jedem Fall gleich', async () => {
  // Wartete die Antwort auf den Mailserver, verriete ihre Dauer, ob es das
  // Konto gibt. Der Versand laeuft deshalb danach im Hintergrund.
  const db = makeDb();
  seedContactsAndEmail(db);
  let release;
  const gate = new Promise((r) => { release = r; });
  const started = [];
  const { app } = await makeAuthApp(db, {
    sendMail: async (m) => { started.push(m); await gate; },
  });
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ask = async (identifier) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/forgot-password`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier }), signal: ctrl.signal,
      });
      return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
    } catch {
      return 'timeout';
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const known = await ask('alice');
    assert.notEqual(known, 'timeout', 'die Antwort wartete auf den Mailversand');
    const unknown = await ask('niemand');
    assert.deepEqual(unknown, known, 'unbekanntes Konto antwortet genauso');
  } finally {
    release();
    server.closeAllConnections?.();
    server.close();
  }
  await app.locals.drain();
  assert.equal(started.length, 1, 'der Versand lief trotzdem');
});

test('emailMatchKey und forgot-password bleiben linear bei langem Leerraum im Inneren', async () => {
  // Ein Regex wie /^\s+|\s+$/ probiert die rechte Alternative an jeder
  // Position neu und laeuft bei Leerraum im INNEREN quadratisch - auf einem
  // oeffentlichen Pfad ohne Anmeldung. Gemessen: 90 000 Leerzeichen, 26 s.
  const { emailMatchKey } = await import('../server/utils/email-match.js');
  const long = `a${' '.repeat(50_000)}b`;
  let t = performance.now();
  emailMatchKey(long);
  const unitMs = performance.now() - t;
  assert.ok(unitMs < 1000, `emailMatchKey brauchte ${Math.round(unitMs)} ms`);

  const db = makeDb();
  seedContactsAndEmail(db);
  const { app } = await makeAuthApp(db);
  t = performance.now();
  const { status } = await callJson(app, 'POST', '/auth/forgot-password', { identifier: long });
  const routeMs = performance.now() - t;
  assert.equal(status, 200);
  assert.ok(routeMs < 2000, `forgot-password samt Hintergrundarbeit brauchte ${Math.round(routeMs)} ms`);
});

test('forgot-password: zwei schnelle Anfragen fuer dasselbe Konto - die zuletzt zugestellte Mail traegt den gueltigen Link', async () => {
  // Der Versand laeuft im Hintergrund. Kommt die zweite Anfrage, bevor der
  // Mailserver die erste angenommen hat, loescht ihr createToken() den ersten
  // Token - und liefen beide Versande nebeneinander, koennte die ERSTE Mail
  // zuletzt ankommen, mit einem Link, der nicht mehr gilt.
  const db = makeDb();
  seedContactsAndEmail(db);
  const calls = [];
  const delivered = [];
  const { app } = await makeAuthApp(db, {
    sendMail: (m) => new Promise((resolve) => {
      calls.push({ m, release: () => { delivered.push(m); resolve(); } });
    }),
  });
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ask = () => fetch(`http://127.0.0.1:${server.address().port}/auth/forgot-password`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'alice' }),
  }).then((r) => r.text());
  const settle = () => new Promise((r) => setTimeout(r, 50));
  let released = 0;
  // Gibt die noch haengenden Versande frei, den spaeter begonnenen zuerst -
  // so, wie ein langsamer Mailserver die Reihenfolge umdrehen kann.
  const releaseReversed = () => {
    const open = calls.slice(released);
    released = calls.length;
    for (const c of open.reverse()) c.release();
  };
  try {
    await ask();
    await settle();
    await ask();
    await settle();
    for (let i = 0; i < 4 && released < calls.length; i += 1) {
      releaseReversed();
      await settle();
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  await app.locals.drain();
  assert.equal(delivered.length, 2, 'beide Anfragen verschicken eine Mail');
  const rows = db.prepare('SELECT token_hash FROM password_resets').all();
  assert.equal(rows.length, 1, 'genau ein Token gilt');
  const lastToken = delivered.at(-1).html.match(/token=([a-f0-9]+)/)[1];
  assert.equal(crypto.createHash('sha256').update(lastToken).digest('hex'), rows[0].token_hash,
    'die zuletzt zugestellte Mail traegt einen Link, der nicht mehr gilt');
});

test('forgot-password: drei schnelle Anfragen ergeben hoechstens zwei Versande, der letzte mit gueltigem Link', async () => {
  // Je Konto laeuft ein Versand und wartet hoechstens einer. Eine dritte
  // Anfrage waehrenddessen faellt weg: der wartende Job erzeugt ohnehin das
  // neueste Token. Ohne Grenze stapelte eine Schleife beliebig viele Jobs.
  const db = makeDb();
  seedContactsAndEmail(db);
  const calls = [];
  const delivered = [];
  const { app } = await makeAuthApp(db, {
    sendMail: (m) => new Promise((resolve) => {
      calls.push({ m, release: () => { delivered.push(m); resolve(); } });
    }),
  });
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ask = () => fetch(`http://127.0.0.1:${server.address().port}/auth/forgot-password`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'alice' }),
  }).then((r) => r.text());
  const settle = () => new Promise((r) => setTimeout(r, 50));
  let released = 0;
  const releaseReversed = () => {
    const open = calls.slice(released);
    released = calls.length;
    for (const c of open.reverse()) c.release();
  };
  try {
    for (let i = 0; i < 3; i += 1) { await ask(); await settle(); }
    for (let i = 0; i < 5 && released < calls.length; i += 1) {
      releaseReversed();
      await settle();
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  await app.locals.drain();
  assert.ok(delivered.length <= 2, `${delivered.length} Versande statt hoechstens zwei`);
  const rows = db.prepare('SELECT token_hash FROM password_resets').all();
  assert.equal(rows.length, 1, 'genau ein Token gilt');
  const lastToken = delivered.at(-1).html.match(/token=([a-f0-9]+)/)[1];
  assert.equal(crypto.createHash('sha256').update(lastToken).digest('hex'), rows[0].token_hash,
    'der zuletzt verschickte Link gilt nicht');
});

test('reset-password rejects an invalid token', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app } = await makeAuthApp(db);
  const { status } = await callJson(app, 'POST', '/auth/reset-password', { token: 'bad', password: 'longenough' });
  assert.equal(status, 400);
});

test('reset-password rejects a short password', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const svc = createPasswordResetService({ db });
  const { token } = svc.createToken(1);
  const { app } = await makeAuthApp(db);
  const { status } = await callJson(app, 'POST', '/auth/reset-password', { token, password: 'short' });
  assert.equal(status, 400);
});

test('reset-password updates the hash and consumes the token', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  // Re-issue the token through the same service instance the route uses:
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  const token = sent[0].html.match(/token=([a-f0-9]+)/)[1];
  const { status } = await callJson(app, 'POST', '/auth/reset-password', { token, password: 'brandnewpw' });
  assert.equal(status, 200);
  const hash = db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash;
  assert.equal(await bcrypt.compare('brandnewpw', hash), true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets').get().c, 0);
});

test('reset-password beendet jede Sitzung des Kontos, auch eine abgelaufene Zeile, und nur dessen', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  db.exec('CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired_at INTEGER NOT NULL)');
  const later = Date.now() + 3_600_000;
  const insert = db.prepare('INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)');
  insert.run('alice-1', JSON.stringify({ userId: 1 }), later);
  insert.run('alice-2', JSON.stringify({ userId: 1 }), later);
  insert.run('alice-stale', JSON.stringify({ userId: 1 }), Date.now() - 1000);
  insert.run('bob-1', JSON.stringify({ userId: 2 }), later);
  insert.run('broken', 'not json', later);
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  const token = sent[0].html.match(/token=([a-f0-9]+)/)[1];
  const { status } = await callJson(app, 'POST', '/auth/reset-password', { token, password: 'brandnewpw' });
  assert.equal(status, 200);
  const left = db.prepare('SELECT sid FROM sessions ORDER BY sid').all().map((r) => r.sid);
  assert.deepEqual(left, ['bob-1', 'broken']);
});
