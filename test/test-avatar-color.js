/**
 * Test: Mitgliedsfarbe nimmt nur #RRGGBB an
 * Zweck: `users.avatar_color` landet bei allen Haushaltsmitgliedern in
 *        `style`-Attributen (Personen-Chips, Siegel, Avatare). `esc()` haelt
 *        das Attribut zu, aber nicht die Deklaration: ein Wert wie
 *        `red;position:fixed;inset:0` legte eine Flaeche ueber fremde Ansichten.
 *        Jeder Schreibweg prueft deshalb auf HEX, und die Anzeige laesst nur
 *        HEX durch.
 * Ausführen: node --experimental-sqlite --test test/test-avatar-color.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { safeHexColor, AVATAR_FALLBACK_COLOR } = await import('../public/utils/color.js');
const db = dbmod.get();

const INJECTION = 'red;position:fixed;inset:0;z-index:9999';

const ADMIN = db.prepare("INSERT INTO users (username, display_name, password_hash, role, avatar_color) VALUES ('admin','Admin','x','admin','#007AFF')").run().lastInsertRowid;
const KID = db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role, avatar_color) VALUES ('kid','Kid','x','member','child','#34C759')").run().lastInsertRowid;
const storedColor = (id) => db.prepare('SELECT avatar_color FROM users WHERE id = ?').get(id).avatar_color;

const actor = { userId: 0, role: 'member' };
const authApp = express();
authApp.use(express.json());
authApp.use(sessionMiddleware);
authApp.use((req, _res, next) => {
  if (actor.userId) { req.session.userId = actor.userId; req.session.role = actor.role; }
  next();
});
authApp.use('/', authRouter);
const authServer = authApp.listen(0, '127.0.0.1');
const authBase = await new Promise((r) => authServer.on('listening', () => r(`http://127.0.0.1:${authServer.address().port}`)));
test.after(() => authServer.close());

async function signIn(userId, role) {
  actor.userId = userId; actor.role = role;
  const res = await fetch(`${authBase}/me`);
  actor.userId = 0;
  const body = await res.json();
  return { cookies: res.headers.getSetCookie().map((raw) => raw.split(';')[0]).join('; '), csrfToken: body.csrfToken };
}
async function authCall(method, path, session, payload) {
  const res = await fetch(`${authBase}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: session.cookies, 'X-CSRF-Token': session.csrfToken || '' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

const hkApp = express();
hkApp.use(express.json());
hkApp.use((req, _res, next) => {
  req.authUserId = ADMIN;
  req.authRole = 'admin';
  req.session = { userId: ADMIN, role: 'admin' };
  req.sessionModuleAccess = null;
  next();
});
hkApp.use('/', housekeepingRouter);
const hkServer = hkApp.listen(0, '127.0.0.1');
const hkBase = await new Promise((r) => hkServer.on('listening', () => r(`http://127.0.0.1:${hkServer.address().port}`)));
test.after(() => hkServer.close());

async function hkPost(body) {
  const res = await fetch(`${hkBase}/worker`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('PATCH /me/profile: ein Mitglied setzt sich keine CSS-Deklaration als Farbe', async () => {
  const session = await signIn(KID, 'member');
  const r = await authCall('PATCH', '/me/profile', session, { avatar_color: INJECTION });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /avatar_color/);
  assert.equal(storedColor(KID), '#34C759', 'Farbe unveraendert');
});

test('PATCH /me/profile: HEX geht durch, leer faellt auf den Standard', async () => {
  const session = await signIn(KID, 'member');
  const ok = await authCall('PATCH', '/me/profile', session, { avatar_color: '#ff9500' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(storedColor(KID), '#ff9500');
  const empty = await authCall('PATCH', '/me/profile', session, { avatar_color: '' });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(storedColor(KID), '#007AFF');
});

test('POST /users und PATCH /users/:id lehnen eine Nicht-HEX-Farbe ab', async () => {
  const session = await signIn(ADMIN, 'admin');
  const created = await authCall('POST', '/users', session, {
    username: 'gast1', display_name: 'Gast', password: 'geheim1234', avatar_color: INJECTION,
  });
  assert.equal(created.status, 400, JSON.stringify(created.body));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'gast1'").get().n, 0);

  const patched = await authCall('PATCH', `/users/${KID}`, session, { avatar_color: 'url(x)' });
  assert.equal(patched.status, 400, JSON.stringify(patched.body));
  assert.equal(storedColor(KID), '#007AFF');
});

test('POST /worker lehnt eine Nicht-HEX-Farbe ab', async () => {
  const r = await hkPost({ display_name: 'Putzhilfe', daily_rate: 50, avatar_color: INJECTION });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE display_name = 'Putzhilfe'").get().n, 0);
});

test('safeHexColor: nur #RRGGBB, sonst der Ersatz', () => {
  assert.equal(safeHexColor('#AbCdEf'), '#AbCdEf');
  assert.equal(safeHexColor(INJECTION), AVATAR_FALLBACK_COLOR);
  assert.equal(safeHexColor('#fff'), AVATAR_FALLBACK_COLOR);
  assert.equal(safeHexColor(null), AVATAR_FALLBACK_COLOR);
  assert.equal(safeHexColor('#123456;color:red', '#000000'), '#000000');
});

test('Migration 269 setzt Altwerte ohne HEX auf den Standard, HEX bleibt', () => {
  const migration = dbmod.MIGRATIONS.find((m) => m.version === 269);
  assert.ok(migration, 'Migration 269 vorhanden');
  const add = (name, colour) => db.prepare("INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES (?, ?, 'x', ?)").run(name, name, colour).lastInsertRowid;
  const bad = add('alt_css', INJECTION);
  const short = add('alt_kurz', '#fff');
  const good = add('alt_hex', '#aBc123');
  db.exec(migration.up);
  assert.equal(storedColor(bad), '#007AFF');
  assert.equal(storedColor(short), '#007AFF');
  assert.equal(storedColor(good), '#aBc123');
});
