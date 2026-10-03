/**
 * Test: Ein Konto der Haushaltshilfe meldet sich auf KEINEM Weg an
 * Zweck: Seit #243 weist `POST /auth/login` ein Personal-Konto (`housekeeping_workers`)
 *        mit 403 ab. Die Regel stand aber nur dort: der OIDC-Callback fand dasselbe
 *        Konto ueber den `sub` oder verknuepfte es ueber eine verifizierte Kontakt-
 *        E-Mail und richtete eine volle Sitzung ein - auch ueber den Umweg des
 *        zweiten Faktors. Diese Suite faehrt deshalb jeden Weg in eine Sitzung als
 *        Verhalten gegen den ECHTEN Router, nicht als Textsuche: eine Regel, die
 *        nur eine Route kennt, ist keine Regel, sondern eine Bitte an die anderen.
 *
 * Wie der Anbieter hineinkommt: `openid-client` wird per `mock.module` ersetzt.
 * Nachgebaut ist nur, was der Callback nach der kryptografischen Pruefung sieht
 * (die Claims und das UserInfo); alles dahinter - Session-Middleware, State aus
 * `/oidc/start`, Kontosuche, Verknuepfung, zweiter Faktor, Sitzungsaufbau - ist
 * der echte Code. Das Personal-Konto legt die echte Housekeeping-Route an, so wie
 * der Admin es tut; nur dessen eigene Anmeldung ist hier vorgeschaltet.
 *
 * Ausfuehren: node --experimental-sqlite --experimental-test-module-mocks --test test/test-staff-sign-in.js
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'staff-sign-in-test-secret';
process.env.DB_PATH = ':memory:';
delete process.env.SESSION_SECURE;
delete process.env.AUTH_ALLOW_PASSWORD_LOGIN;
delete process.env.OIDC_ALLOW_SIGNUP;
delete process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM;
process.env.OIDC_ISSUER = 'https://idp.example/';
process.env.OIDC_CLIENT_ID = 'yuvomi';
process.env.OIDC_CLIENT_SECRET = 'shh';
process.env.OIDC_REDIRECT_URI = 'http://127.0.0.1/api/v1/auth/oidc/callback';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

/** Was der Anbieter beim naechsten Callback liefert. */
let idp = { claims: {}, userinfo: {} };

// `namedExports` statt `exports`: die CI faehrt Node 22 und 24, dort gibt es nur
// diese Form; neuere Node-Versionen warnen, fuehren sie aber aus.
mock.module('openid-client', {
  namedExports: {
    discovery: async () => ({ issuer: process.env.OIDC_ISSUER }),
    ClientSecretBasic: () => () => {},
    randomState: () => 'test-state',
    randomNonce: () => 'test-nonce',
    randomPKCECodeVerifier: () => 'test-verifier',
    calculatePKCECodeChallenge: async () => 'test-challenge',
    buildAuthorizationUrl: () => new URL('https://idp.example/authorize'),
    authorizationCodeGrant: async () => ({ access_token: 'test-access-token', claims: () => idp.claims }),
    fetchUserInfo: async () => idp.userinfo,
  },
});

const dbmod = await import('../server/db.js');
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { hashPassword } = await import('../server/utils/password.js');
const { generateSecret, hashRecoveryCode } = await import('../server/utils/totp.js');
const database = dbmod.get();

const ADMIN = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('staff-test-admin', 'Admin', 'x', 'admin')
`).run().lastInsertRowid);

const app = express();
app.use(express.json());
app.use('/as-admin/housekeeping', (req, _res, next) => {
  req.authUserId = ADMIN;
  req.authRole = 'admin';
  req.session = { userId: ADMIN, role: 'admin' };
  next();
}, housekeepingRouter);
app.use(sessionMiddleware);
// Nur fuer die Abwehr in setupAuthSession: legt den Wartezustand des zweiten
// Faktors direkt an, so wie ihn ein kuenftiger dritter Anmeldeweg anlegen
// koennte, der die Personal-Regel vergisst.
app.post('/__test/pending-two-factor/:userId', (req, res) => {
  req.session.pendingTwoFactor = { userId: Number(req.params.userId), expiresAt: Date.now() + 60_000 };
  req.session.save(() => res.json({ ok: true }));
});
app.use('/api/v1/auth', authRouter);
const server = app.listen(0, '127.0.0.1');
const base = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

const BLOCKED = '/login?error=oidc_sign_in_blocked';

function cookiesOf(res, fallback = '') {
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return set.length ? set.join('; ') : fallback;
}

function sessionsOf(userId) {
  return database.prepare('SELECT sess FROM sessions').all()
    .filter((row) => JSON.parse(row.sess).userId === userId).length;
}

const userRow = (username) => database.prepare('SELECT * FROM users WHERE username = ?').get(username);

/** Legt ein Personal-Konto ueber die echte Route an, wie der Admin es tut. */
async function createStaff(username, { email } = {}) {
  const res = await fetch(`${base}/as-admin/housekeeping/worker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: `Hilfe ${username}`, username, daily_rate: 50, ...(email ? { email } : {}) }),
  });
  assert.equal(res.status, 201, `Vorbedingung: Personal-Konto ${username} angelegt`);
  const user = userRow(username);
  assert.ok(database.prepare('SELECT 1 FROM housekeeping_workers WHERE user_id = ?').get(user.id),
    'Vorbedingung: das Konto ist als Personal eingetragen');
  return user;
}

/** Schaltet den zweiten Faktor scharf und gibt einen gueltigen Wiederherstellungscode zurueck. */
function enableTwoFactor(userId) {
  database.prepare(`
    INSERT INTO user_totp (user_id, secret, confirmed_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  `).run(userId, generateSecret());
  const code = `RECOVERY${userId}CODE`;
  database.prepare('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)').run(userId, hashRecoveryCode(code));
  return code;
}

/** Faehrt eine SSO-Anmeldung von `/oidc/start` bis zur Frage, ob eine Sitzung besteht. */
async function ssoSignIn({ claims, userinfo }) {
  idp = { claims: { iss: process.env.OIDC_ISSUER, ...claims }, userinfo: { sub: claims.sub, ...userinfo } };
  const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(start.status, 302, 'Vorbedingung: /oidc/start leitet zum Anbieter');
  const startCookie = cookiesOf(start);
  const callback = await fetch(`${base}/api/v1/auth/oidc/callback?code=test-code&state=test-state`, {
    redirect: 'manual',
    headers: { cookie: startCookie },
  });
  const cookie = cookiesOf(callback, startCookie);
  const me = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie } });
  return { status: callback.status, location: callback.headers.get('location'), cookie, meStatus: me.status };
}

async function verifySecondFactor(cookie, code) {
  const res = await fetch(`${base}/api/v1/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code }),
  });
  return { status: res.status, cookie: cookiesOf(res, cookie) };
}

// --------------------------------------------------------------------------
// Die bestehende Sperre (#243) und die Kontrollfaelle
// --------------------------------------------------------------------------

test('Passwort-Login: ein Personal-Konto bekommt weiterhin 403 und keine Sitzung', async () => {
  const staff = await createStaff('hilfe-passwort');
  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(await hashPassword('richtiges-passwort-123'), staff.id);

  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'hilfe-passwort', password: 'richtiges-passwort-123' }),
  });

  assert.equal(res.status, 403);
  // `reason` seit #1607: an ihm erkennt die App, dass dieser Satz eine eigene Auskunft ist.
  assert.deepEqual(await res.json(), { error: 'This account cannot sign in.', code: 403, reason: 'account_cannot_sign_in' });
  assert.equal(sessionsOf(staff.id), 0);
});

test('Passwort-Login: ein Mitglied meldet sich weiterhin an', async () => {
  const { lastInsertRowid } = database.prepare(`
    INSERT INTO users (username, display_name, password_hash) VALUES ('mitglied-passwort', 'Mitglied', ?)
  `).run(await hashPassword('richtiges-passwort-123'));

  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'mitglied-passwort', password: 'richtiges-passwort-123' }),
  });

  assert.equal(res.status, 200);
  assert.equal(sessionsOf(Number(lastInsertRowid)), 1);
});

test('SSO: eine unbekannte Identitaet bekommt weiterhin ein Mitgliedskonto und eine Sitzung', async () => {
  const result = await ssoSignIn({ claims: { sub: 'member-sub-new' }, userinfo: { preferred_username: 'sso-mitglied' } });

  assert.equal(result.location, '/');
  assert.equal(result.meStatus, 200);
  const user = database.prepare('SELECT * FROM users WHERE oidc_sub = ?').get('member-sub-new');
  assert.equal(sessionsOf(user.id), 1);
});

test('SSO: ein vorbereitetes Mitglied mit Kontakt-E-Mail wird weiterhin verknuepft und angemeldet', async () => {
  // Ohne Passwort, wie ein Admin es fuer die erste SSO-Anmeldung vorbereitet:
  // nur so ein Konto verknuepft ueber die Adresse (GHSA-6pmj-w42g-g6qv).
  const { lastInsertRowid } = database.prepare(`
    INSERT INTO users (username, display_name, password_hash) VALUES ('mitglied-mail', 'Mitglied Mail', '$oidc$')
  `).run();
  const memberId = Number(lastInsertRowid);
  database.prepare('INSERT INTO contacts (name, email, family_user_id) VALUES (?, ?, ?)')
    .run('Mitglied Mail', 'mitglied@example.com', memberId);

  const result = await ssoSignIn({
    claims: { sub: 'member-sub-link', email_verified: true },
    userinfo: { email: 'mitglied@example.com', email_verified: true },
  });

  assert.equal(result.location, '/');
  assert.equal(result.meStatus, 200);
  assert.equal(userRow('mitglied-mail').oidc_sub, 'member-sub-link');
  assert.equal(sessionsOf(memberId), 1);
});

// --------------------------------------------------------------------------
// Die Wege, auf denen die Regel fehlte
// --------------------------------------------------------------------------

test('(b) SSO mit der Kontakt-E-Mail eines Personal-Kontos: keine Verknuepfung, kein Konto, keine Sitzung', async () => {
  const staff = await createStaff('hilfe-mail', { email: 'hilfe@example.com' });
  const usersBefore = database.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const result = await ssoSignIn({
    claims: { sub: 'idp-sub-staff-mail', email_verified: true },
    userinfo: { email: 'hilfe@example.com', email_verified: true, preferred_username: 'hilfe-idp' },
  });

  // Alle Befunde in EINEM Vergleich: faellt er, zeigt der Diff den ganzen
  // Zustand (Weiterleitung, Sitzung, geschriebener sub, neues Konto) statt nur
  // die erste Abweichung.
  assert.deepEqual({
    location: result.location,
    me: result.meStatus,
    sessions: sessionsOf(staff.id),
    staffSub: userRow('hilfe-mail').oidc_sub,
    newUsers: database.prepare('SELECT COUNT(*) AS n FROM users').get().n - usersBefore,
  }, {
    location: BLOCKED,
    me: 401,
    sessions: 0,
    staffSub: null,
    newUsers: 0,
  });
});

test('(a) SSO auf ein Personal-Konto, das bereits einen sub traegt: keine Sitzung', async () => {
  const staff = await createStaff('hilfe-sub');
  database.prepare('UPDATE users SET oidc_sub = ?, oidc_provider = ? WHERE id = ?')
    .run('idp-sub-staff', process.env.OIDC_ISSUER, staff.id);

  const result = await ssoSignIn({ claims: { sub: 'idp-sub-staff' }, userinfo: {} });

  assert.deepEqual(
    { location: result.location, me: result.meStatus, sessions: sessionsOf(staff.id) },
    { location: BLOCKED, me: 401, sessions: 0 },
  );
});

test('(a) mit zweitem Faktor: die Absage kommt VOR dem Wartezustand, der Code oeffnet nichts', async () => {
  const staff = await createStaff('hilfe-2fa');
  database.prepare('UPDATE users SET oidc_sub = ? WHERE id = ?').run('idp-sub-staff-2fa', staff.id);
  const code = enableTwoFactor(staff.id);

  const result = await ssoSignIn({ claims: { sub: 'idp-sub-staff-2fa' }, userinfo: {} });
  // Mit der Absage vor dem Wartezustand gibt es nichts zu pruefen: 401 "No pending sign-in".
  const verify = await verifySecondFactor(result.cookie, code);

  assert.deepEqual(
    { location: result.location, verify: verify.status, sessions: sessionsOf(staff.id) },
    { location: BLOCKED, verify: 401, sessions: 0 },
  );
});

test('Abwehr in setupAuthSession: ein Weg, der die Regel vergisst, stellt trotzdem keine Sitzung aus', async () => {
  const staff = await createStaff('hilfe-abwehr');
  const code = enableTwoFactor(staff.id);

  const seeded = await fetch(`${base}/__test/pending-two-factor/${staff.id}`, { method: 'POST' });
  const verify = await verifySecondFactor(cookiesOf(seeded), code);

  // Der Status bleibt bewusst offen (die Abwehr ist ein Programmierfehler-Melder,
  // kein Anmeldeweg); zugesichert wird, was zaehlt: keine Sitzung.
  assert.deepEqual(
    { ok: verify.status === 200, sessions: sessionsOf(staff.id) },
    { ok: false, sessions: 0 },
  );
});
