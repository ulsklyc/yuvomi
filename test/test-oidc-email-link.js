/**
 * Test: Die erste SSO-Anmeldung folgt keiner Adresse, die ein Mitglied selbst setzen kann
 *       (GHSA-6pmj-w42g-g6qv)
 *
 * Bis v2.69.0 verknuepfte die erste SSO-Anmeldung per E-Mail, sobald GENAU EIN
 * unverknuepftes Konto die verifizierte Adresse trug, und legte bei ZWEI oder
 * mehr still ein neues Konto an, das den `sub` fuer immer band. Beide Mengen
 * konnte ein gewoehnliches Mitglied steuern: ueber die Adresse im eigenen
 * Profil, am eigenen Kontakt oder an einem Gast der geteilten Ausgaben.
 *
 * - Zwei Treffer: die Person bekam statt ihres vorbereiteten Kontos ein leeres
 *   Neukonto (bei einem vorbereiteten Admin-Konto: ein Mitgliedskonto).
 * - Ein Treffer: trug das Mitglied die Adresse einer Person ein, die sich erst
 *   noch anmeldet, landete deren erste Anmeldung im Konto des Mitglieds - das
 *   das Passwort kennt. `OIDC_ALLOW_SIGNUP=false` half dagegen nicht.
 *
 * Gefahren wird die echte Strecke `/oidc/start` -> `/oidc/callback` gegen den
 * ganzen Server; ersetzt ist nur `openid-client`, also das, was der Callback
 * nach der kryptografischen Pruefung sieht (wie test/test-oidc-contact.js).
 *
 * Ausfuehren: node --experimental-sqlite --experimental-test-module-mocks --test test/test-oidc-email-link.js
 */
delete process.env.AUTH_ALLOW_PASSWORD_LOGIN;
delete process.env.OIDC_ALLOW_SIGNUP;
delete process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM;

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// Statisch: server-ready.js laedt server/index.js erst IN startTestServer(),
// also nach dem mock.module unten - und test:db-isolation sieht so, dass der
// Helfer DB_PATH vor dem Laden setzt.
import { startTestServer } from './server-ready.js';

/** Was der Anbieter beim naechsten Callback liefert. */
let idp = { claims: {}, userinfo: {} };

// `namedExports` statt `exports`: die CI faehrt Node 22 und 24, dort gibt es nur
// diese Form.
mock.module('openid-client', {
  namedExports: {
    discovery: async () => ({ issuer: 'https://idp.example/' }),
    ClientSecretBasic: () => () => {},
    randomState: () => 'test-state',
    randomNonce: () => 'test-nonce',
    randomPKCECodeVerifier: () => 'test-verifier',
    calculatePKCECodeChallenge: async () => 'test-challenge',
    buildAuthorizationUrl: () => new URL('https://idp.example/authorize'),
    authorizationCodeGrant: async () => ({ access_token: 't', claims: () => idp.claims }),
    fetchUserInfo: async () => idp.userinfo,
  },
});

const { baseUrl: base } = await startTestServer({
  name: 'oidc-email-link',
  env: {
    SESSION_SECRET: 'oidc-email-link-secret-oidc-email-link-secret',
    OIDC_ISSUER: 'https://idp.example/',
    OIDC_CLIENT_ID: 'yuvomi',
    OIDC_CLIENT_SECRET: 'shh',
    OIDC_REDIRECT_URI: 'http://127.0.0.1/api/v1/auth/oidc/callback',
  },
});
const database = (await import('../server/db.js')).get();

const cookiesOf = (res, fallback = '') => {
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return set.length ? set.join('; ') : fallback;
};

/** Faehrt eine erste bzw. weitere SSO-Anmeldung bis zum Redirect des Callbacks. */
async function ssoSignIn({ sub, email, name }) {
  idp = {
    claims: { iss: 'https://idp.example/', sub, email_verified: true },
    userinfo: { sub, email, email_verified: true, name, preferred_username: name.toLowerCase() },
  };
  const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(start.status, 302, 'Vorbedingung: /oidc/start leitet zum Anbieter');
  const cb = await fetch(`${base}/api/v1/auth/oidc/callback?code=c&state=test-state`, {
    redirect: 'manual', headers: { cookie: cookiesOf(start) },
  });
  return cb.headers.get('location');
}

async function login(username, password) {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `Vorbedingung: Anmeldung ${username}`);
  const cookie = cookiesOf(res);
  const me = await (await fetch(`${base}/api/v1/auth/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

async function call(sess, method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: sess.cookie, 'X-CSRF-Token': sess.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const boundTo = (sub) => database.prepare('SELECT id, username, role FROM users WHERE oidc_sub = ?').get(sub);
const userCount = () => database.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const contactIdOf = (userId) => database.prepare('SELECT id FROM contacts WHERE family_user_id = ?').get(userId).id;

/** Wie ein Admin ein Konto fuer die erste SSO-Anmeldung vorbereitet. */
async function prepareSsoOnly(username, email, extra = {}) {
  const r = await call(admin, 'POST', '/auth/users', { username, display_name: username, sso_only: true, email, ...extra });
  assert.equal(r.status, 201, `Vorbedingung: SSO-only-Konto ${username}: ${JSON.stringify(r.body)}`);
  return r.body.user.id;
}

/** Wie die Adresse vor diesem Update schon am Kontakt stehen konnte. */
function setContactEmailDirectly(userId, email) {
  database.prepare('UPDATE contacts SET email = ? WHERE family_user_id = ?').run(email, userId);
}

function withSignup(value, fn) {
  const before = process.env.OIDC_ALLOW_SIGNUP;
  if (value === undefined) delete process.env.OIDC_ALLOW_SIGNUP; else process.env.OIDC_ALLOW_SIGNUP = value;
  return fn().finally(() => {
    if (before === undefined) delete process.env.OIDC_ALLOW_SIGNUP; else process.env.OIDC_ALLOW_SIGNUP = before;
  });
}

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'root', display_name: 'Root', password: 'rootpass123' }),
});
const admin = await login('root', 'rootpass123');
{
  const r = await call(admin, 'POST', '/auth/users', { username: 'mallory', display_name: 'Mallory', password: 'mallorypass1' });
  assert.equal(r.status, 201, `Vorbedingung: Mitglied mallory: ${JSON.stringify(r.body)}`);
}
const malloryId = database.prepare("SELECT id FROM users WHERE username = 'mallory'").get().id;
const mal = await login('mallory', 'mallorypass1');

test('Kontrolle: die erste SSO-Anmeldung findet das vorbereitete Konto ohne Passwort', async () => {
  await prepareSsoOnly('carla', 'carla@example.com', { system_admin: true });
  const loc = await ssoSignIn({ sub: 'sub-carla', email: 'carla@example.com', name: 'Carla' });
  assert.equal(loc, '/');
  assert.equal(boundTo('sub-carla')?.username, 'carla');
  assert.equal(boundTo('sub-carla')?.role, 'admin');
});

test('Kontrolle: der erste Admin (mit Passwort) verknuepft sich weiterhin ueber seine Adresse', async () => {
  // Seine Adresse kann nur ein Admin gesetzt haben - er selbst.
  const rootId = database.prepare("SELECT id FROM users WHERE username = 'root'").get().id;
  const r = await call(admin, 'PATCH', '/auth/me/profile', { display_name: 'Root', email: 'root@example.com' });
  assert.equal(r.status, 200);
  assert.equal(await ssoSignIn({ sub: 'sub-root', email: 'root@example.com', name: 'Root' }), '/');
  assert.equal(boundTo('sub-root')?.id, rootId);
});

test('Profil: ein Mitglied setzt sich keine Adresse, die schon ein anderes Konto traegt', async () => {
  await prepareSsoOnly('vera', 'vera@example.com', { system_admin: true });
  for (const email of ['vera@example.com', '  VERA@example.com\t']) {
    const r = await call(mal, 'PATCH', '/auth/me/profile', { display_name: 'Mallory', email });
    assert.equal(r.status, 409, `${JSON.stringify(email)} wurde angenommen: ${r.status}`);
    assert.equal(r.body?.reason, 'email_in_use', 'der Client braucht den Grund fuer eine uebersetzte Meldung');
  }
  const loc = await ssoSignIn({ sub: 'sub-vera', email: 'vera@example.com', name: 'Vera' });
  assert.equal(loc, '/', 'die Anmeldung gelingt');
  assert.equal(boundTo('sub-vera')?.username, 'vera', 'und landet im vorbereiteten Konto, nicht in einem Neukonto');
  assert.equal(boundTo('sub-vera')?.role, 'admin');
});

test('eigener Kontakt: dieselbe Regel ueber die Kontakte-Route, Haupt- und Zweitadresse', async () => {
  await prepareSsoOnly('wanda', 'wanda@example.com');
  const own = contactIdOf(malloryId);
  let r = await call(mal, 'PUT', `/contacts/${own}`, { email: 'wanda@example.com' });
  assert.equal(r.status, 409, `Hauptadresse angenommen: ${r.status} ${JSON.stringify(r.body)}`);
  r = await call(mal, 'PUT', `/contacts/${own}`, { emails: [{ label: 'work', value: 'Wanda@Example.com' }] });
  assert.equal(r.status, 409, `Zweitadresse angenommen: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.reason, 'email_in_use');
});

test('Bestand: zwei Konten mit derselben Adresse - abgewiesen, kein Neukonto, sub bleibt frei', async () => {
  const ottoId = await prepareSsoOnly('otto', 'otto@example.com');
  setContactEmailDirectly(malloryId, 'otto@example.com');
  try {
    for (const signup of [undefined, 'false']) {
      const before = userCount();
      const loc = await withSignup(signup, () => ssoSignIn({ sub: 'sub-otto', email: 'otto@example.com', name: 'Otto' }));
      assert.equal(loc, '/login?error=oidc_email_ambiguous', `signup=${signup}`);
      assert.equal(boundTo('sub-otto'), undefined, 'der sub darf an keinem Konto haengen');
      assert.equal(userCount(), before, 'es darf kein Konto entstehen');
    }
  } finally {
    setContactEmailDirectly(malloryId, null);
  }
  // Behoben: die naechste Anmeldung findet das vorbereitete Konto.
  const loc = await ssoSignIn({ sub: 'sub-otto', email: 'otto@example.com', name: 'Otto' });
  assert.equal(loc, '/');
  assert.equal(boundTo('sub-otto')?.id, ottoId);
});

test('Bestand: ein unveraendert gespeichertes Profil bleibt speicherbar', async () => {
  // Die Pruefung gilt NEUEN Adressen. Wer vor dem Update eine doppelte Adresse
  // hatte, muss trotzdem Namen oder Farbe aendern koennen.
  await prepareSsoOnly('paula', 'paula@example.com');
  setContactEmailDirectly(malloryId, 'paula@example.com');
  try {
    const r = await call(mal, 'PATCH', '/auth/me/profile', { display_name: 'Mallory M', email: 'paula@example.com' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally {
    setContactEmailDirectly(malloryId, null);
    await call(mal, 'PATCH', '/auth/me/profile', { display_name: 'Mallory' });
  }
});

test('eindeutige Adresse: die erste Anmeldung einer neuen Person landet NICHT im Konto des Mitglieds', async () => {
  const r = await call(mal, 'PATCH', '/auth/me/profile', { display_name: 'Mallory', email: 'newbie@example.com' });
  assert.equal(r.status, 200, 'eine freie Adresse darf das Mitglied weiter setzen');
  try {
    for (const signup of [undefined, 'false']) {
      const before = userCount();
      const loc = await withSignup(signup, () => ssoSignIn({ sub: 'sub-newbie', email: 'newbie@example.com', name: 'Newbie' }));
      assert.equal(loc, '/login?error=oidc_link_required', `signup=${signup}`);
      assert.equal(boundTo('sub-newbie'), undefined, 'der sub darf nicht am Konto des Mitglieds haengen');
      assert.equal(userCount(), before, 'und es entsteht auch kein stilles Zweitkonto');
    }
  } finally {
    await call(mal, 'PATCH', '/auth/me/profile', { display_name: 'Mallory', email: '' });
  }
});

test('Konto mit Passwort: die Person verknuepft angemeldet unter Einstellungen, danach findet SSO es', async () => {
  // Der Ausweg, den die Absage oidc_link_required nennt (#832).
  const r = await call(admin, 'POST', '/auth/users', { username: 'ines', display_name: 'Ines', password: 'inespass123', email: 'ines@example.com' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await ssoSignIn({ sub: 'sub-ines', email: 'ines@example.com', name: 'Ines' }), '/login?error=oidc_link_required');

  const ines = await login('ines', 'inespass123');
  const start = await call(ines, 'POST', '/auth/oidc/link/start');
  assert.equal(start.status, 200, JSON.stringify(start.body));
  idp = {
    claims: { iss: 'https://idp.example/', sub: 'sub-ines', email_verified: true },
    userinfo: { sub: 'sub-ines', email: 'ines@example.com', email_verified: true, name: 'Ines' },
  };
  const cb = await fetch(`${base}/api/v1/auth/oidc/callback?code=c&state=test-state`, {
    redirect: 'manual', headers: { cookie: ines.cookie },
  });
  assert.equal(cb.headers.get('location'), '/settings/personal/account?oidc_linked=1');
  assert.equal(await ssoSignIn({ sub: 'sub-ines', email: 'ines@example.com', name: 'Ines' }), '/');
  assert.equal(boundTo('sub-ines')?.username, 'ines');
});

test('Gast der geteilten Ausgaben: ein Mitglied legt keinen mit der Adresse eines Kontos an', async () => {
  await prepareSsoOnly('gerda', 'gerda@example.com', { system_admin: true });
  const g = await call(mal, 'POST', '/split-expenses/groups', { name: 'Trip' });
  assert.equal(g.status, 201, `Vorbedingung: Gruppe: ${JSON.stringify(g.body)}`);
  const r = await call(mal, 'POST', `/split-expenses/groups/${g.body.data.id}/guests`, {
    display_name: 'Gerda G', email: 'gerda@example.com', password: 'guestpass123',
  });
  assert.equal(r.status, 409, `Gast angelegt: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.reason, 'email_in_use');
});

test('Gast aus einem Kontakt: dieselbe Regel, wenn ein freier Kontakt zum Gast wird', async () => {
  await prepareSsoOnly('hilde', 'hilde@example.com');
  const c = await call(mal, 'POST', '/contacts', { name: 'Hilde Kontakt', email: 'hilde@example.com' });
  assert.equal(c.status, 201, `Vorbedingung: Kontakt: ${JSON.stringify(c.body)}`);
  const g = await call(mal, 'POST', '/split-expenses/groups', { name: 'Hut' });
  assert.equal(g.status, 201);
  const r = await call(mal, 'POST', `/split-expenses/groups/${g.body.data.id}/members`, { contact_id: c.body.data.id, role: 'guest' });
  assert.equal(r.status, 409, `Gast aus Kontakt angelegt: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.reason, 'email_in_use');
});

test('Gaeste zaehlen fuer die SSO-Verknuepfung nicht: kein Mehrdeutig-Machen, kein Uebernehmen', async () => {
  // Ein Gast mit derselben Adresse (ein Admin darf ihn so anlegen) stoert die
  // Verknuepfung des vorbereiteten Kontos nicht ...
  const idaId = await prepareSsoOnly('ida', 'ida@example.com', { system_admin: true });
  const g = await call(admin, 'POST', '/split-expenses/groups', { name: 'Admin trip' });
  assert.equal(g.status, 201);
  let r = await call(admin, 'POST', `/split-expenses/groups/${g.body.data.id}/guests`, {
    display_name: 'Ida G', email: 'ida@example.com', password: 'guestpass123',
  });
  assert.equal(r.status, 201, `ein Admin darf eine Adresse bewusst doppelt vergeben: ${JSON.stringify(r.body)}`);
  assert.equal(await ssoSignIn({ sub: 'sub-ida', email: 'ida@example.com', name: 'Ida' }), '/');
  assert.equal(boundTo('sub-ida')?.id, idaId);

  // ... und ein Gast allein wird nicht verknuepft: die Person bekommt ihr
  // eigenes Konto, nicht den Gast, dessen Passwort das Mitglied gewaehlt hat.
  const mg = await call(mal, 'POST', '/split-expenses/groups', { name: 'Lonely' });
  r = await call(mal, 'POST', `/split-expenses/groups/${mg.body.data.id}/guests`, {
    display_name: 'Lonely G', email: 'lonely@example.com', password: 'guestpass123',
  });
  assert.equal(r.status, 201, 'eine freie Adresse bleibt fuer einen Gast erlaubt');
  const guestId = r.body.data.id;
  assert.equal(await ssoSignIn({ sub: 'sub-lonely', email: 'lonely@example.com', name: 'Lonely' }), '/');
  const bound = boundTo('sub-lonely');
  assert.ok(bound, 'Vorbedingung: ein Konto traegt den sub');
  assert.notEqual(bound.id, guestId, 'der sub haengt am Gast des Mitglieds');
});

test('ein Admin darf eine Adresse bewusst doppelt vergeben (Familienpostfach)', async () => {
  const r1 = await call(admin, 'POST', '/auth/users', { username: 'kid1', display_name: 'Kid 1', password: 'kidpass1234', email: 'family@example.com' });
  assert.equal(r1.status, 201);
  const r2 = await call(admin, 'POST', '/auth/users', { username: 'kid2', display_name: 'Kid 2', password: 'kidpass1234' });
  assert.equal(r2.status, 201);
  const r = await call(admin, 'PATCH', `/auth/users/${r2.body.user.id}`, {
    username: 'kid2', display_name: 'Kid 2', email: 'family@example.com',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
