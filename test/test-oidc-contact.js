/**
 * Test: Ein Konto, das bei der ersten SSO-Anmeldung entsteht, bekommt seinen Kontakt (#1357)
 * Zweck: Jeder andere Weg, auf dem ein Haushaltsmitglied entsteht - Einladung,
 *        Ersteinrichtung, Admin, Personal -, ruft `syncFamilyMemberArtifacts`
 *        und legt damit den Kontakt an, an dem die E-Mail-Adresse haengt (etwa
 *        fuer das Verschicken einer Einkaufsliste). `findOrCreateOidcUser` tat
 *        das nicht. Entschieden in D#1254: beim ANLEGEN Name und eine
 *        VERIFIZIERTE Adresse (`email_verified: true`) uebernehmen; kein Bild,
 *        kein Geburtsdatum, und bei spaeteren Anmeldungen kein Abgleich (bis D#848).
 *
 * Gefahren wird die echte Strecke `/oidc/start` -> `/oidc/callback` gegen den
 * echten Router und die voll migrierte Datenbank; ersetzt ist nur `openid-client`,
 * also das, was der Callback nach der kryptografischen Pruefung sieht (Claims und
 * UserInfo) - wie in test/test-staff-sign-in.js.
 *
 * Ausfuehren: node --experimental-sqlite --experimental-test-module-mocks --test test/test-oidc-contact.js
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'oidc-contact-test-secret';
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
// diese Form.
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
const database = dbmod.get();

const app = express();
app.use(express.json());
app.use(sessionMiddleware);
app.use('/api/v1/auth', authRouter);
const server = app.listen(0, '127.0.0.1');
const base = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

function cookiesOf(res, fallback = '') {
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return set.length ? set.join('; ') : fallback;
}

/** Faehrt eine SSO-Anmeldung von `/oidc/start` bis zum Redirect des Callbacks. */
async function ssoSignIn({ claims, userinfo }) {
  idp = { claims: { iss: process.env.OIDC_ISSUER, ...claims }, userinfo: { sub: claims.sub, ...userinfo } };
  const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(start.status, 302, 'Vorbedingung: /oidc/start leitet zum Anbieter');
  const callback = await fetch(`${base}/api/v1/auth/oidc/callback?code=test-code&state=test-state`, {
    redirect: 'manual',
    headers: { cookie: cookiesOf(start) },
  });
  return callback.headers.get('location');
}

const userBySub = (sub) => database.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub);
const contactsOf = (userId) => database.prepare('SELECT * FROM contacts WHERE family_user_id = ?').all(userId);
const birthdaysOf = (userId) => database.prepare('SELECT * FROM birthdays WHERE family_user_id = ?').all(userId);

test('erste SSO-Anmeldung mit verifizierter Adresse: Kontakt mit Name und dieser Adresse', async () => {
  const location = await ssoSignIn({
    claims: { sub: 'contact-verified', email_verified: true },
    userinfo: { name: 'Vera Verifiziert', preferred_username: 'vera', email: 'vera@example.com', email_verified: true },
  });
  assert.equal(location, '/', 'Vorbedingung: die Anmeldung gelingt');

  const user = userBySub('contact-verified');
  const contacts = contactsOf(user.id);
  assert.equal(contacts.length, 1, 'genau ein Kontakt fuer das neue Konto');
  assert.equal(contacts[0].name, 'Vera Verifiziert');
  assert.equal(contacts[0].email, 'vera@example.com');
  assert.equal(contacts[0].category, 'misc', 'dieselbe Kategorie wie auf jedem anderen Anlageweg');
  assert.equal(contacts[0].phone, null, 'keine Telefonnummer - kein phone-Scope');
  assert.equal(birthdaysOf(user.id).length, 0, 'kein Geburtstag aus dem Anbieter');
});

test('email_verified aus dem ID-Token zaehlt wie aus dem UserInfo', async () => {
  await ssoSignIn({
    claims: { sub: 'contact-verified-idtoken', email_verified: true },
    userinfo: { name: 'Ida Token', email: 'ida@example.com' },
  });
  const user = userBySub('contact-verified-idtoken');
  assert.equal(contactsOf(user.id)[0]?.email, 'ida@example.com');
});

test('unverifizierte Adresse: Kontakt entsteht, aber ohne die Adresse', async () => {
  await ssoSignIn({
    claims: { sub: 'contact-unverified' },
    userinfo: { name: 'Ulla Unbestaetigt', email: 'ulla@example.com', email_verified: false },
  });
  const user = userBySub('contact-unverified');
  const contacts = contactsOf(user.id);
  assert.equal(contacts.length, 1, 'der Kontakt entsteht trotzdem, wie auf jedem anderen Anlageweg');
  assert.equal(contacts[0].name, 'Ulla Unbestaetigt');
  assert.equal(contacts[0].email, null, 'eine unverifizierte Adresse wird nicht uebernommen');
});

test('fehlender email_verified-Claim: die Adresse wird nicht uebernommen', async () => {
  await ssoSignIn({
    claims: { sub: 'contact-no-claim' },
    userinfo: { name: 'Nora Ohneclaim', email: 'nora@example.com' },
  });
  const user = userBySub('contact-no-claim');
  assert.equal(contactsOf(user.id)[0]?.email, null);
});

test('zweite Anmeldung mit geaendertem Namen und Adresse aendert nichts', async () => {
  await ssoSignIn({
    claims: { sub: 'contact-second', email_verified: true },
    userinfo: { name: 'Sam Erst', email: 'sam@example.com', email_verified: true },
  });
  const user = userBySub('contact-second');
  const before = contactsOf(user.id);
  assert.equal(before.length, 1, 'Vorbedingung: Kontakt nach der ersten Anmeldung');

  const location = await ssoSignIn({
    claims: { sub: 'contact-second', email_verified: true },
    userinfo: { name: 'Sam Zweit', email: 'sam-neu@example.com', email_verified: true },
  });
  assert.equal(location, '/', 'Vorbedingung: die zweite Anmeldung gelingt');

  assert.deepEqual(contactsOf(user.id), before, 'Kontakt unveraendert');
  assert.equal(userBySub('contact-second').display_name, 'Sam Erst', 'Anzeigename unveraendert');
});

test('OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM gilt dem Verknuepfen, nicht dem Kontakt', async () => {
  process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM = 'true';
  try {
    await ssoSignIn({
      claims: { sub: 'contact-trust-optin' },
      userinfo: { name: 'Tara Vertrauen', email: 'tara@example.com' },
    });
  } finally {
    delete process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM;
  }
  const user = userBySub('contact-trust-optin');
  assert.equal(contactsOf(user.id).length, 1);
  assert.equal(contactsOf(user.id)[0].email, null, 'nur email_verified: true bringt die Adresse in den Kontakt');
});

test('Leerraum um die Adresse wird abgeschnitten', async () => {
  await ssoSignIn({
    claims: { sub: 'contact-trim', email_verified: true },
    userinfo: { name: 'Tim Trim', email: '  a@x.de  ', email_verified: true },
  });
  assert.equal(contactsOf(userBySub('contact-trim').id)[0]?.email, 'a@x.de');
});

test('eine Adresse ueber MAX_TITLE (200) wird nicht uebernommen', async () => {
  const long = `${'l'.repeat(195)}@x.de_`;
  assert.ok(long.length > 200, 'Vorbedingung: laenger als MAX_TITLE');
  await ssoSignIn({
    claims: { sub: 'contact-long', email_verified: true },
    userinfo: { name: 'Lara Lang', email: long, email_verified: true },
  });
  const contacts = contactsOf(userBySub('contact-long').id);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].email, null);
});

/**
 * Legt ein lokales Mitglied samt Kontakt an, wie es die Verknuepfung vorfindet:
 * ohne Passwort, wie ein Admin es fuer die erste SSO-Anmeldung vorbereitet -
 * nur so ein Konto verknuepft ueber die Adresse (GHSA-6pmj-w42g-g6qv).
 */
function addLocalMember(username, email) {
  const id = Number(database.prepare(`
    INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, '$oidc$')
  `).run(username, `Lokal ${username}`).lastInsertRowid);
  database.prepare("INSERT INTO contacts (name, category, email, family_user_id) VALUES (?, 'misc', ?, ?)")
    .run(`Lokal ${username}`, email, id);
  return id;
}

test('Verknuepfung: der vorhandene Kontakt bleibt unveraendert und der einzige', async () => {
  const memberId = addLocalMember('lokal-link', 'lokal@example.com');
  const before = contactsOf(memberId);

  const location = await ssoSignIn({
    claims: { sub: 'contact-link', email_verified: true },
    userinfo: { name: 'Anderer Name', email: 'lokal@example.com', email_verified: true },
  });
  assert.equal(location, '/', 'Vorbedingung: die Anmeldung gelingt');
  assert.equal(userBySub('contact-link')?.id, memberId, 'Vorbedingung: verknuepft, kein neues Konto');
  assert.deepEqual(contactsOf(memberId), before);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM contacts WHERE lower(email) = ?').get('lokal@example.com').n, 1);
});

test('Verknuepfung: Leerraum und Grossschreibung in der Adresse des Anbieters verfehlen das Konto nicht', async () => {
  const memberId = addLocalMember('lokal-trim', 'Link@x.de');
  const location = await ssoSignIn({
    claims: { sub: 'contact-link-trim', email_verified: true },
    userinfo: { name: 'Link Trim', email: '  link@x.de ', email_verified: true },
  });
  assert.equal(location, '/', 'Vorbedingung: die Anmeldung gelingt');
  assert.equal(userBySub('contact-link-trim')?.id, memberId, 'verknuepft statt eines zweiten Kontos');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM contacts WHERE lower(trim(email)) = 'link@x.de'").get().n, 1,
    'kein zweiter Mitglieder-Kontakt mit derselben Adresse');
});

test('scheitert die Kontaktanlage, entsteht auch kein Konto', async () => {
  database.exec(`
    CREATE TRIGGER test_block_contact BEFORE INSERT ON contacts
    WHEN NEW.name = 'Kaputt Kontakt'
    BEGIN SELECT RAISE(ABORT, 'contact blocked by test'); END;
  `);
  try {
    const location = await ssoSignIn({
      claims: { sub: 'contact-atomic', email_verified: true },
      userinfo: { name: 'Kaputt Kontakt', preferred_username: 'kaputt', email: 'kaputt@example.com', email_verified: true },
    });
    assert.equal(location, '/login?error=oidc_failed');
  } finally {
    database.exec('DROP TRIGGER test_block_contact');
  }
  assert.equal(userBySub('contact-atomic'), undefined, 'kein Konto ohne Kontakt');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'kaputt'").get().n, 0);
});
