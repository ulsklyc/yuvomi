/**
 * Modul: Einladungs-Test
 * Zweck: Token-Lebenszyklus des Einladungs-Service (create/verify/accept/revoke/
 *        list/cleanup) gegen das echte Migrations-SQL aus v121, dazu die fünf
 *        Einladungs-Routen: Admin-Gate, CSRF, und dass Rolle und Familienrolle
 *        aus der Einladung stammen statt aus dem Body des Eingeladenen.
 * Ausführen: node --experimental-sqlite test/test-invites.js
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
// Muss vor dem ersten db.js-Import stehen, sonst legt der Import eine echte
// Datenbankdatei an. Deshalb sind die db-nahen Importe unten dynamisch.
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

const { createInviteService } = await import('../server/services/invites.js');

// Feste Zeitachse statt Date.now(): jeder Ablauf-Fall ist damit reproduzierbar.
const T0 = 1_700_000_000_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AFTER_TTL = T0 + TTL_MS + 1;

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MIGRATIONS_SQL[1]);   // users
  db.exec(MIGRATIONS_SQL[121]); // invites
  db.exec(MIGRATIONS_SQL[171]); // invites.permissions (#869)
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash)
    VALUES (1, 'alice', 'Alice', 'x'), (2, 'bob', 'Bob', 'x')`).run();
  return db;
}

const svcAt = (db, at) => createInviteService({ db, now: () => at });

test('createInvite speichert nur den Hash, nie den Klartext-Token', () => {
  const db = makeDb();
  const { token, id } = svcAt(db, T0).createInvite({ createdBy: 1 });
  const row = db.prepare('SELECT token_hash, expires_at FROM invites WHERE id = ?').get(id);
  assert.ok(token.length >= 40);
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(row.expires_at, T0 + TTL_MS);
});

test('createInvite übernimmt Rolle, Familienrolle und Einladenden', () => {
  const db = makeDb();
  const { id } = svcAt(db, T0).createInvite({
    email: 'carl@test', username: 'carl', displayName: 'Carl',
    role: 'admin', familyRole: 'child', createdBy: 1,
  });
  const row = db.prepare('SELECT * FROM invites WHERE id = ?').get(id);
  assert.equal(row.email, 'carl@test');
  assert.equal(row.username, 'carl');
  assert.equal(row.display_name, 'Carl');
  assert.equal(row.role, 'admin');
  assert.equal(row.family_role, 'child');
  assert.equal(row.created_by, 1);
});

test('createInvite ohne Angaben fällt auf member/other zurück', () => {
  const db = makeDb();
  const { id } = svcAt(db, T0).createInvite();
  const row = db.prepare('SELECT role, family_role, created_by FROM invites WHERE id = ?').get(id);
  assert.equal(row.role, 'member');
  assert.equal(row.family_role, 'other');
  assert.equal(row.created_by, null);
});

test('verifyToken liefert die Einladung, ein unbekannter Token liefert null', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  const { token, id } = svc.createInvite({ username: 'carl', familyRole: 'child', createdBy: 1 });
  const row = svc.verifyToken(token);
  assert.equal(row.id, id);
  assert.equal(row.username, 'carl');
  assert.equal(row.family_role, 'child');
  assert.equal(svc.verifyToken('nope'), null);
  assert.equal(svc.verifyToken(''), null);
  assert.equal(svc.verifyToken(undefined), null);
});

test('verifyToken gibt den token_hash nicht mit heraus', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  const { token } = svc.createInvite({ createdBy: 1 });
  assert.equal('token_hash' in svc.verifyToken(token), false);
});

test('verifyToken liefert null nach Ablauf der Gültigkeit', () => {
  const db = makeDb();
  const { token } = svcAt(db, T0).createInvite({ createdBy: 1 });
  assert.notEqual(svcAt(db, T0 + TTL_MS - 1).verifyToken(token), null);
  assert.equal(svcAt(db, AFTER_TTL).verifyToken(token), null);
});

test('eine eingelöste Einladung ist kein zweites Mal einlösbar', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  const { token } = svc.createInvite({ createdBy: 1 });
  assert.equal(svc.markAccepted(token, 2), 1);
  assert.equal(svc.verifyToken(token), null);
  // Der zweite Einlöseversuch trifft ins Leere: das WHERE deckt den Wettlauf ab.
  assert.equal(svc.markAccepted(token, 2), 0);
});

test('markAccepted greift nach Ablauf nicht mehr, auch mit gültig geprüftem Token', () => {
  const db = makeDb();
  const { token } = svcAt(db, T0).createInvite({ createdBy: 1 });
  // Der Ablauf faellt zwischen verifyToken und markAccepted: beim Einloesen liegt
  // dazwischen ein bcrypt-Hash von rund 300 ms.
  assert.notEqual(svcAt(db, T0).verifyToken(token), null);
  assert.equal(svcAt(db, AFTER_TTL).markAccepted(token, 2), 0);
  assert.equal(db.prepare('SELECT accepted_at FROM invites').get().accepted_at, null);
});

test('markAccepted löscht nicht, sondern hält die Spur wer wen eingeladen hat', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  const { token, id } = svc.createInvite({ createdBy: 1 });
  svc.markAccepted(token, 2);
  const row = db.prepare('SELECT * FROM invites WHERE id = ?').get(id);
  assert.equal(row.created_by, 1);
  assert.equal(row.accepted_user_id, 2);
  assert.equal(row.accepted_at, '2023-11-14T22:13:20Z'); // T0 im created_at-Format
});

test('eine widerrufene Einladung ist nicht mehr einlösbar und bleibt bestehen', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  const { token, id } = svc.createInvite({ createdBy: 1 });
  assert.equal(svc.revoke(id), 1);
  assert.equal(svc.verifyToken(token), null);
  assert.equal(svc.markAccepted(token, 2), 0);
  const row = db.prepare('SELECT revoked_at FROM invites WHERE id = ?').get(id);
  assert.ok(row.revoked_at);
});

test('revoke greift weder bei eingelösten noch bei bereits widerrufenen Einladungen', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  const accepted = svc.createInvite({ createdBy: 1 });
  svc.markAccepted(accepted.token, 2);
  assert.equal(svc.revoke(accepted.id), 0);

  const open = svc.createInvite({ createdBy: 1 });
  assert.equal(svc.revoke(open.id), 1);
  assert.equal(svc.revoke(open.id), 0);
  assert.equal(svc.revoke(9999), 0);
});

test('listOpen liefert nie den token_hash mit', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  svc.createInvite({ username: 'carl', createdBy: 1 });
  const [row] = svc.listOpen();
  assert.equal(row.username, 'carl');
  assert.equal('token_hash' in row, false);
});

test('listOpen zeigt weder eingelöste noch widerrufene noch abgelaufene Einladungen', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  const accepted = svc.createInvite({ username: 'accepted', createdBy: 1 });
  const revoked = svc.createInvite({ username: 'revoked', createdBy: 1 });
  svc.createInvite({ username: 'open', createdBy: 1 });
  svc.markAccepted(accepted.token, 2);
  svc.revoke(revoked.id);

  assert.deepEqual(svc.listOpen().map((r) => r.username), ['open']);
  // Nach Ablauf ist auch die offene Einladung aus der Liste verschwunden.
  assert.deepEqual(svcAt(db, AFTER_TTL).listOpen(), []);
});

test('cleanupExpired räumt abgelaufene ab, eingelöste und widerrufene bleiben', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  const accepted = svc.createInvite({ username: 'accepted', createdBy: 1 });
  const revoked = svc.createInvite({ username: 'revoked', createdBy: 1 });
  svc.createInvite({ username: 'stale', createdBy: 1 });
  svc.markAccepted(accepted.token, 2);
  svc.revoke(revoked.id);

  // Nur die Einladung, die nie zu etwas geführt hat, verschwindet. Ein Widerruf
  // ist eine Entscheidung: revoke() löscht deshalb nicht, und der Aufräumjob
  // darf sie nicht nachträglich aufheben.
  assert.equal(svcAt(db, AFTER_TTL).cleanupExpired(), 1);
  assert.deepEqual(
    db.prepare('SELECT username FROM invites ORDER BY id').all().map((r) => r.username),
    ['accepted', 'revoked']
  );
});

test('cleanupExpired lässt noch gültige Einladungen unangetastet', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  svc.createInvite({ createdBy: 1 });
  assert.equal(svc.cleanupExpired(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM invites').get().c, 1);
});

// --- Routen ----------------------------------------------------------------
// Gegen die echte In-Memory-DB aus db.js (nicht gegen DatabaseSync): die Routen
// brauchen eine Transaktion, und der Einlöse-Pfad legt echte Nutzer an.
const dbmod = await import('../server/db.js');
const { buildInviteRoutes } = await import('../server/auth.js');
const routeDb = dbmod.get();

function mkUser(username, role = 'member') {
  return Number(routeDb.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, family_role)
     VALUES (?, ?, 'x', ?, 'other')`
  ).run(username, username.toUpperCase(), role).lastInsertRowid);
}
const ADMIN = mkUser('admin', 'admin');
const MEMBER = mkUser('member', 'member');
const ADM = { id: ADMIN, role: 'admin' };
const MEM = { id: MEMBER, role: 'member' };

const CSRF = 'a'.repeat(64);
const sentMails = [];
let actor = ADM;
let mailConfigured = true;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = { csrfToken: CSRF, ...(actor ? { userId: actor.id, role: actor.role } : {}) };
  next();
});
const inviteRouter = express.Router();
buildInviteRoutes(inviteRouter, {
  database: routeDb,
  inviteService: createInviteService({ db: routeDb }),
  emailService: {
    isConfigured: () => mailConfigured,
    sendMail: async (mail) => { sentMails.push(mail); },
  },
  baseUrl: 'https://yuvomi.test',
  limiter: (_req, _res, next) => next(), // Rate-Limit im Test überbrücken
});
app.use('/auth', inviteRouter);
const server = app.listen(0, '127.0.0.1');
const routeBase = await new Promise((r) =>
  server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, { actor: a, body, csrf = CSRF } = {}) {
  if (a !== undefined) actor = a;
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${routeBase}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leerer Body */ }
  return { status: res.status, body: json };
}

/** Legt eine Einladung über die Route an und liefert deren Klartext-Token. */
async function invite(body = {}) {
  const res = await call('POST', '/auth/invites', { actor: ADM, body });
  assert.equal(res.status, 201, `Einladung fehlgeschlagen: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

test('Gate: Nicht-Admin bekommt 403 auf allen drei Admin-Routen', async () => {
  for (const [method, path, body] of [
    ['GET', '/auth/invites', undefined],
    ['POST', '/auth/invites', { display_name: 'Nope' }],
    ['DELETE', '/auth/invites/1', undefined],
  ]) {
    const res = await call(method, path, { actor: MEM, body });
    assert.equal(res.status, 403, `${method} ${path} ist nicht gegen Nicht-Admins gesichert`);
  }
});

test('Gate: ohne Session gibt es 401 statt 403', async () => {
  const res = await call('GET', '/auth/invites', { actor: null });
  assert.equal(res.status, 401);
});

test('CSRF: POST und DELETE ohne Token werden abgewiesen', async () => {
  const post = await call('POST', '/auth/invites', { actor: ADM, body: { display_name: 'X' }, csrf: null });
  assert.equal(post.status, 403);
  const del = await call('DELETE', '/auth/invites/1', { actor: ADM, csrf: null });
  assert.equal(del.status, 403);
});

test('POST /invites liefert den Klartext-Token genau einmal, die DB nur den Hash', async () => {
  const { invite: created, token } = await invite({ username: 'carla', display_name: 'Carla', family_role: 'child' });
  assert.ok(token.length >= 40);
  assert.equal(created.username, 'carla');
  assert.equal(created.family_role, 'child');
  assert.equal(created.role, 'member');
  assert.equal(created.created_by, ADMIN);
  assert.equal('token_hash' in created, false);
  const row = routeDb.prepare('SELECT token_hash FROM invites WHERE id = ?').get(created.id);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('POST /invites weist ungültige Eingaben ab', async () => {
  const cases = [
    [{ username: 'ab' }, 400],                       // zu kurz
    [{ username: 'kein leerzeichen' }, 400],         // ungültige Zeichen
    [{ display_name: 'x'.repeat(129) }, 400],
    [{ family_role: 'dog' }, 400],
    [{ email: 'keine-adresse' }, 400],
    [{ send_email: true }, 400],                     // ohne Adresse
    [{ username: 'admin' }, 409],                    // Name schon vergeben
  ];
  for (const [body, expected] of cases) {
    const res = await call('POST', '/auth/invites', { actor: ADM, body });
    assert.equal(res.status, expected, `unerwartet für ${JSON.stringify(body)}`);
  }
});

test('POST /invites verschickt die Mail mit BASE_URL-Link und meldet email_sent', async () => {
  sentMails.length = 0;
  const { token, email_sent } = await invite({ email: 'dora@test', send_email: true, username: 'dora' });
  assert.equal(email_sent, true);
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].to, 'dora@test');
  assert.match(sentMails[0].html, /https:\/\/yuvomi\.test\/join\?token=[a-f0-9]+/);
  assert.ok(sentMails[0].html.includes(token), 'der Link trägt den erzeugten Token');
});

test('POST /invites meldet email_sent false, wenn kein Mailversand konfiguriert ist', async () => {
  sentMails.length = 0;
  mailConfigured = false;
  const { email_sent } = await invite({ email: 'edo@test', send_email: true, username: 'edo' });
  mailConfigured = true;
  assert.equal(email_sent, false, 'das UI muss erfahren, dass nur der Link bleibt');
  assert.equal(sentMails.length, 0);
});

test('GET /invites liefert nie token oder token_hash', async () => {
  await invite({ username: 'frida' });
  const res = await call('GET', '/auth/invites', { actor: ADM });
  assert.equal(res.status, 200);
  const listed = res.body.data.invites;
  assert.ok(listed.some((i) => i.username === 'frida'));
  for (const row of listed) {
    assert.equal('token_hash' in row, false);
    assert.equal('token' in row, false);
  }
});

test('GET /invites/preview: Unsinn-Token liefert valid false statt 500', async () => {
  for (const query of ['?token=quatsch', '?token=', '']) {
    const res = await call('GET', `/auth/invites/preview${query}`, { actor: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.valid, false);
  }
});

test('GET /invites/preview: gültiger Token liefert die vorgegebenen Namen', async () => {
  const { token } = await invite({ username: 'gustav', display_name: 'Gustav' });
  const res = await call('GET', `/auth/invites/preview?token=${token}`, { actor: null });
  assert.equal(res.body.data.valid, true);
  assert.equal(res.body.data.username, 'gustav');
  assert.equal(res.body.data.display_name, 'Gustav');
});

test('accept legt den Nutzer an; Rolle und Familienrolle stammen aus der Einladung', async () => {
  const { token } = await invite({ username: 'hanna', display_name: 'Hanna', family_role: 'child' });
  const res = await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'geheim12345' }, csrf: null,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.username, 'hanna');

  const user = routeDb.prepare('SELECT * FROM users WHERE username = ?').get('hanna');
  assert.equal(user.display_name, 'Hanna');
  assert.equal(user.role, 'member');
  assert.equal(user.family_role, 'child');
  // Das Familienmitglied bekommt seine Artefakte wie bei POST /auth/users.
  assert.ok(routeDb.prepare('SELECT 1 FROM contacts WHERE family_user_id = ?').get(user.id));
});

test('accept mit manipuliertem role/family_role im Body erzeugt trotzdem einen member', async () => {
  const { token } = await invite({ username: 'iris', family_role: 'child' });
  const res = await call('POST', '/auth/invites/accept', {
    actor: null,
    body: {
      token, password: 'geheim12345',
      role: 'admin', system_admin: true, family_role: 'parent',
    },
    csrf: null,
  });
  assert.equal(res.status, 201);
  const user = routeDb.prepare('SELECT role, family_role FROM users WHERE username = ?').get('iris');
  assert.equal(user.role, 'member', 'der Eingeladene darf sich nicht selbst zum Admin schreiben');
  assert.equal(user.family_role, 'child');
});

test('accept: eine als admin ausgesprochene Einladung wird auch als admin eingelöst', async () => {
  const { token } = await invite({ username: 'jonas', system_admin: true });
  await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'geheim12345' }, csrf: null,
  });
  assert.equal(routeDb.prepare('SELECT role FROM users WHERE username = ?').get('jonas').role, 'admin');
});

test('accept: ohne vorgegebenen Namen zählt der aus dem Body', async () => {
  const { token } = await invite({});
  const res = await call('POST', '/auth/invites/accept', {
    actor: null,
    body: { token, password: 'geheim12345', username: 'karla', display_name: 'Karla' },
    csrf: null,
  });
  assert.equal(res.status, 201);
  const user = routeDb.prepare('SELECT display_name FROM users WHERE username = ?').get('karla');
  assert.equal(user.display_name, 'Karla');
});

test('accept: die eingeladene Adresse wird zur Kontaktadresse des neuen Nutzers', async () => {
  const { token } = await invite({ username: 'lars', email: 'lars@test' });
  await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'geheim12345' }, csrf: null,
  });
  const user = routeDb.prepare('SELECT id FROM users WHERE username = ?').get('lars');
  const contact = routeDb.prepare('SELECT email FROM contacts WHERE family_user_id = ?').get(user.id);
  assert.equal(contact.email, 'lars@test', 'sonst findet der neue Nutzer den Weg über /forgot-password nicht');
});

test('accept weist kurze Passwörter, fehlende und unbekannte Token ab', async () => {
  const { token } = await invite({ username: 'mona' });
  const cases = [
    [{ token, password: 'kurz' }, 400],
    [{ token }, 400],
    [{ password: 'geheim12345' }, 400],
    [{ token: 'quatsch', password: 'geheim12345' }, 400],
  ];
  for (const [body, expected] of cases) {
    const res = await call('POST', '/auth/invites/accept', { actor: null, body, csrf: null });
    assert.equal(res.status, expected, `unerwartet für ${JSON.stringify(body)}`);
  }
  // Nach den Fehlversuchen ist die Einladung immer noch einlösbar.
  const ok = await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'geheim12345' }, csrf: null,
  });
  assert.equal(ok.status, 201);
});

test('accept: derselbe Token ein zweites Mal scheitert und legt keinen zweiten Nutzer an', async () => {
  const { token } = await invite({ username: 'nils' });
  assert.equal((await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'geheim12345' }, csrf: null,
  })).status, 201);
  const second = await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'anderes12345' }, csrf: null,
  });
  assert.equal(second.status, 400);
  assert.equal(routeDb.prepare('SELECT COUNT(*) c FROM users WHERE username = ?').get('nils').c, 1);
});

test('accept nach dem Widerruf scheitert', async () => {
  const { invite: created, token } = await invite({ username: 'olga' });
  const del = await call('DELETE', `/auth/invites/${created.id}`, { actor: ADM });
  assert.equal(del.status, 200);
  assert.equal(del.body.data.ok, true);

  const res = await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'geheim12345' }, csrf: null,
  });
  assert.equal(res.status, 400);
  assert.equal(routeDb.prepare('SELECT COUNT(*) c FROM users WHERE username = ?').get('olga').c, 0);
});

test('accept mit inzwischen belegtem Benutzernamen endet in 409, nicht in 500', async () => {
  const { token } = await invite({ username: 'petra' });
  mkUser('petra'); // jemand anderes war schneller
  const res = await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'geheim12345' }, csrf: null,
  });
  assert.equal(res.status, 409);
});

test('DELETE /invites: unbekannte und bereits widerrufene ID enden in 404', async () => {
  const { invite: created } = await invite({ username: 'rosa' });
  assert.equal((await call('DELETE', `/auth/invites/${created.id}`, { actor: ADM })).status, 200);
  assert.equal((await call('DELETE', `/auth/invites/${created.id}`, { actor: ADM })).status, 404);
  assert.equal((await call('DELETE', '/auth/invites/999999', { actor: ADM })).status, 404);
  assert.equal((await call('DELETE', '/auth/invites/keine-zahl', { actor: ADM })).status, 400);
});

test('die öffentlichen Routen liegen vor dem globalen requireAuth der App', async () => {
  // Die Routen-Tests oben laufen gegen den Router allein. In server/index.js
  // hängt aber ein `app.use('/api/v1', requireAuth)` über allem - stünde der
  // auth-Router dahinter, gäbe /join für jeden Ausgeloggten nur noch 401.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const mounted = src.indexOf("app.use('/api/v1/auth', authRouter)");
  const guarded = src.indexOf("app.use('/api/v1', requireAuth)");
  assert.ok(mounted > -1 && guarded > -1, 'Einhängepunkte in server/index.js nicht gefunden');
  assert.ok(mounted < guarded, 'der auth-Router muss vor dem globalen requireAuth eingehängt sein');
});

// --- Startrechte (#869) ----------------------------------------------------
// Die Frage, die diese Gruppe stellt: bekommt ein neu eingeladenes Mitglied die
// Rechte, die der Admin beim EINLADEN gewählt hat - und zwar bevor es sich zum
// ersten Mal anmeldet? Bis v2.61 bekam es immer alle, weil eine fehlende Zeile
// vollen Zugriff bedeutet.

test('createInvite speichert das Startrechte-Set als Text, oder null', () => {
  const db = makeDb();
  const svc = svcAt(db, T0);
  const withPreset = svc.createInvite({ permissions: '{"modules":{"health":"none"}}' });
  const without = svc.createInvite({});
  assert.equal(
    db.prepare('SELECT permissions FROM invites WHERE id = ?').get(withPreset.id).permissions,
    '{"modules":{"health":"none"}}',
  );
  // null und nicht "{}": eine Einladung ohne Vorgabe soll sich exakt wie jede
  // vor Migration 171 verhalten, und die hatten die Spalte gar nicht.
  assert.equal(db.prepare('SELECT permissions FROM invites WHERE id = ?').get(without.id).permissions, null);
});

test('die enge Vorlage sperrt genau die drei persönlichen Module', async () => {
  const { invitePresetPermissions, INVITE_RESTRICTED_MODULES } = await import('../server/permissions.js');
  const restricted = invitePresetPermissions('restricted');
  assert.deepEqual(Object.keys(restricted.modules).sort(), [...INVITE_RESTRICTED_MODULES].sort());
  for (const access of Object.values(restricted.modules)) assert.equal(access, 'none');
  // 'role' schreibt nichts: das Rollenprofil greift von selbst, eine Kopie
  // davon als Mitglied-Zeilen wäre eine zweite Wahrheit.
  assert.equal(invitePresetPermissions('role'), null);
});

test('POST /invites ohne permission_preset nimmt die ENGE Vorlage', async () => {
  // Das ist die Umkehr selbst. Ein Client, der das Feld nicht kennt, darf nicht
  // versehentlich mit vollem Zugriff einladen.
  const { invite: created } = await invite({ username: 'sina' });
  const stored = JSON.parse(created.permissions);
  assert.equal(stored.modules.health, 'none');
  assert.equal(stored.modules.budget, 'none');
  assert.equal(stored.modules.documents, 'none');
});

test('POST /invites mit preset "role" speichert keine Vorgabe', async () => {
  const { invite: created } = await invite({ username: 'timo', permission_preset: 'role' });
  assert.equal(created.permissions, null);
});

test('POST /invites weist eine unbekannte Vorlage ab', async () => {
  const res = await call('POST', '/auth/invites', {
    actor: ADM, body: { username: 'ulla', permission_preset: 'everything' },
  });
  assert.equal(res.status, 400);
});

test('accept schreibt die Startrechte, bevor das Konto benutzbar ist', async () => {
  const { token } = await invite({ username: 'vera' });
  const res = await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'geheim12345' }, csrf: null,
  });
  assert.equal(res.status, 201);
  const userId = routeDb.prepare('SELECT id FROM users WHERE username = ?').get('vera').id;
  const rows = routeDb.prepare(
    `SELECT resource_key, access FROM access_permissions
     WHERE subject_type = 'user' AND subject_id = ? ORDER BY resource_key`
  ).all(String(userId));
  assert.deepEqual(rows, [
    { resource_key: 'budget', access: 'none' },
    { resource_key: 'documents', access: 'none' },
    { resource_key: 'health', access: 'none' },
  ]);
  // Und die Auflösung sagt dasselbe - die Zeilen allein wären nur die halbe
  // Zusicherung, wenn resolvePermissions() sie nicht anwendete.
  const { resolvePermissions } = await import('../server/permissions.js');
  const resolved = resolvePermissions(routeDb, { id: userId, role: 'member', family_role: 'other' });
  assert.equal(resolved.modules.health, 'none');
  assert.equal(resolved.widgets.cycle, 'none', 'ein Widget erbt die Sperre seines Moduls');
  assert.equal(resolved.modules.tasks, 'write', 'was die Vorlage nicht nennt, bleibt offen');
});

test('accept einer Einladung OHNE Vorgabe schreibt keine Zeile', async () => {
  // Der Bestandsfall: so verhalten sich alle Einladungen, die vor Migration 171
  // entstanden sind, und alle mit der Vorlage "wie das Rollenprofil".
  const { token } = await invite({ username: 'wanda', permission_preset: 'role' });
  const res = await call('POST', '/auth/invites/accept', {
    actor: null, body: { token, password: 'geheim12345' }, csrf: null,
  });
  assert.equal(res.status, 201);
  const userId = routeDb.prepare('SELECT id FROM users WHERE username = ?').get('wanda').id;
  assert.equal(
    routeDb.prepare(
      "SELECT COUNT(*) c FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?"
    ).get(String(userId)).c,
    0,
  );
});

test('teardown: Server schließen', async () => {
  await new Promise((r) => server.close(r));
});
