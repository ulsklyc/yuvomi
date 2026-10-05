/**
 * Modul: E-Mail-Adressen verknuepfter Kontakte und Konten aus Kontakten
 * Zweck: Die E-Mail-Adressen eines Kontakts mit `family_user_id` fuehren zu
 *        seinem Konto (Passwort-Reset, SSO-Verknuepfung). Sie aendern nur die
 *        verknuepfte Person selbst oder ein Admin, und nur mit vollem Zugriff
 *        (Sitzung oder ungescoptes Token) - ueber jeden Schreibweg. Alle
 *        anderen Felder bleiben fuer Mitglieder editierbar. Dazu: ein Konto,
 *        das Geteilte Ausgaben aus einem Kontakt anlegen, ist immer ein Gast
 *        und nie ein Haushaltsmitglied.
 *
 * JEDER TEST STELLT SEINEN AUSGANGSZUSTAND SELBST HER (`reset()`), damit ein
 * roter Test auf seine eigene Ursache zeigt und nicht auf den Rest, den ein
 * frueherer Test hinterlassen hat.
 *
 * Ausfuehren: npm run test:contact-identity-guard
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'contact-identity-guard',
  env: { SESSION_SECRET: 'contact-identity-guard-secret-min32chars' },
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  if (res.status !== 200) return { status: res.status };
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { status: 200, cookie, csrfToken: me.csrfToken };
}

async function call(s, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  else { headers.Cookie = s.cookie; headers['X-CSRF-Token'] = s.csrfToken; }
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const admin = await login('admin', 'adminpass123');
assert.equal(admin.status, 200);
assert.equal((await call(admin, 'POST', '/auth/users', { username: 'kid', display_name: 'Kid', password: 'kidpass1234' })).status, 201);
const kid = await login('kid', 'kidpass1234');
assert.equal(kid.status, 200);

const db = (await import('../server/db.js')).get();
const { findOrCreateOidcUser, buildResetRoutes } = await import('../server/auth.js');
const { createPasswordResetService } = await import('../server/services/password-reset.js');
const { parseAndMergeContact } = await import('../server/services/cardav-sync.js');
const { isHouseholdMember } = await import('../server/services/household-members.js');

const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
const kidId = db.prepare("SELECT id FROM users WHERE username = 'kid'").get().id;
const contactIdOf = (userId) => {
  let row = db.prepare('SELECT id FROM contacts WHERE family_user_id = ?').get(userId);
  if (!row) {
    db.prepare("INSERT INTO contacts (name, category, family_user_id) VALUES ('Member', 'misc', ?)").run(userId);
    row = db.prepare('SELECT id FROM contacts WHERE family_user_id = ?').get(userId);
  }
  return row.id;
};
const adminContactId = contactIdOf(adminId);
const kidContactId = contactIdOf(kidId);

const ATTACKER = 'evil@attacker.test';

/** Der Ausgangszustand, den jeder Test voraussetzt - von Grund auf gesetzt. */
function reset() {
  db.prepare(`
    UPDATE contacts SET email = 'admin@home.test', phone = '+49 30 5550100', notes = NULL, address = NULL,
           organization = NULL, carddav_account_id = NULL, carddav_uid = NULL,
           carddav_addressbook_url = NULL, carddav_origin = NULL
    WHERE id = ?`).run(adminContactId);
  db.prepare(`
    UPDATE contacts SET email = 'kid@home.test', phone = NULL, notes = NULL, address = NULL
    WHERE id = ?`).run(kidContactId);
  db.prepare('DELETE FROM contact_emails WHERE contact_id IN (?, ?)').run(adminContactId, kidContactId);
  db.prepare('UPDATE users SET oidc_sub = NULL, oidc_provider = NULL WHERE id IN (?, ?)').run(adminId, kidId);
  db.prepare('DELETE FROM carddav_accounts').run();
}
beforeEach(reset);

const emailsOf = (contactId) => ({
  email: db.prepare('SELECT email FROM contacts WHERE id = ?').get(contactId).email,
  emails: db.prepare('SELECT value FROM contact_emails WHERE contact_id = ? ORDER BY id').all(contactId).map((r) => r.value),
});
const ADMIN_UNTOUCHED = { email: 'admin@home.test', emails: [] };

async function tokenFor(subjectUserId, scopes) {
  const body = { name: `t-${subjectUserId}-${scopes ? scopes.join(',') : 'full'}`, subject_user_id: subjectUserId };
  if (scopes) body.scopes = scopes;
  const created = await call(admin, 'POST', '/auth/api-tokens', body);
  assert.equal(created.status, 201);
  return { token: created.body.token };
}

/** forgot-password gegen dieselbe Datenbank, mit mitschreibendem Mailversand. */
async function withResetRoutes(fn) {
  const sent = [];
  const pending = [];
  const app = express();
  app.use(express.json());
  const router = express.Router();
  buildResetRoutes(router, {
    database: db,
    emailService: { isConfigured: () => true, sendMail: async (m) => { sent.push(m); } },
    resetService: createPasswordResetService({ db }),
    baseUrl: 'https://yuvomi.test',
    limiter: (_req, _res, next) => next(),
    // Der Versand laeuft nach der Antwort; `post` wartet ihn ab, damit `sent`
    // danach verlaesslich zaehlt statt vom Zufall der Ereignisschleife.
    defer: (fn) => { pending.push(new Promise((r) => setImmediate(() => Promise.resolve(fn()).finally(r)))); },
  });
  app.use('/auth', router);
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/auth`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => {
    const out = { status: r.status, body: await r.json().catch(() => null) };
    await Promise.all(pending.splice(0));
    return out;
  });
  try {
    return await fn({ post, sent });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

// -------------------------------------------------------------------------
// Wer die Adressen eines verknuepften Kontakts aendern darf
// -------------------------------------------------------------------------

test('a member cannot change the primary email of another member\'s linked contact', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContactId}`, { email: ATTACKER });
  assert.equal(r.status, 403);
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
});

test('a member cannot add a secondary email to another member\'s linked contact', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContactId}`, {
    emails: [{ label: 'work', value: ` ${ATTACKER} ` }],
  });
  assert.equal(r.status, 403);
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
});

test('a member cannot swap the address set by moving it into the list either', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContactId}`, {
    email: 'admin@home.test',
    emails: [{ label: 'other', value: 'admin@home.test', isPrimary: true }, { label: 'other', value: ATTACKER }],
  });
  assert.equal(r.status, 403);
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
});

test('a member-scoped API token is refused', async () => {
  const r = await call(await tokenFor(kidId, ['contacts:write']), 'PUT', `/contacts/${adminContactId}`, { email: ATTACKER });
  assert.equal(r.status, 403);
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
});

test('an admin\'s token scoped to contacts:write is refused, on the admin\'s own contact too', async () => {
  const scoped = await tokenFor(adminId, ['contacts:write']);
  const own = await call(scoped, 'PUT', `/contacts/${adminContactId}`, { email: ATTACKER });
  assert.equal(own.status, 403);
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
  const other = await call(scoped, 'PUT', `/contacts/${kidContactId}`, { emails: [{ label: 'work', value: ATTACKER }] });
  assert.equal(other.status, 403);
  assert.deepEqual(emailsOf(kidContactId), { email: 'kid@home.test', emails: [] });
});

test('a member\'s own scoped token cannot change the member\'s own addresses', async () => {
  const r = await call(await tokenFor(kidId, ['contacts:write']), 'PUT', `/contacts/${kidContactId}`, { email: ATTACKER });
  assert.equal(r.status, 403);
  assert.deepEqual(emailsOf(kidContactId), { email: 'kid@home.test', emails: [] });
});

test('a scoped token can still change the other fields of a linked contact', async () => {
  const r = await call(await tokenFor(kidId, ['contacts:write']), 'PUT', `/contacts/${adminContactId}`, {
    notes: 'Via token', email: 'admin@home.test',
  });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT notes FROM contacts WHERE id = ?').get(adminContactId).notes, 'Via token');
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
});

test('unscoped tokens keep working: the admin\'s on a member, the member\'s on themselves', async () => {
  const adminFull = await call(await tokenFor(adminId, null), 'PUT', `/contacts/${kidContactId}`, { email: 'kid.a@home.test' });
  assert.equal(adminFull.status, 200);
  assert.equal(emailsOf(kidContactId).email, 'kid.a@home.test');
  const kidFull = await call(await tokenFor(kidId, null), 'PUT', `/contacts/${kidContactId}`, { email: 'kid.b@home.test' });
  assert.equal(kidFull.status, 200);
  assert.equal(emailsOf(kidContactId).email, 'kid.b@home.test');
});

test('a member can still edit the other fields of a linked contact, with the unchanged form around them', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContactId}`, {
    notes: 'Allergic to cats', address: 'Main St 1',
    // So sendet das Formular: alle Felder, die Hauptadresse als erste Zeile.
    email: 'admin@home.test',
    emails: [{ label: 'other', value: 'admin@home.test', isPrimary: true }],
  });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT notes, address FROM contacts WHERE id = ?').get(adminContactId);
  assert.equal(row.notes, 'Allergic to cats');
  assert.equal(row.address, 'Main St 1');
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
});

test('a member who only changes the letter case is not refused, and the stored spelling stays', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContactId}`, {
    notes: 'Case only',
    email: ' Admin@Home.TEST ',
    emails: [{ label: 'other', value: 'ADMIN@home.test', isPrimary: true }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
  assert.equal(db.prepare('SELECT notes FROM contacts WHERE id = ?').get(adminContactId).notes, 'Case only');
  // Eine wirklich andere Adresse bleibt verweigert.
  const other = await call(kid, 'PUT', `/contacts/${adminContactId}`, { email: 'Admin@Home.test.evil' });
  assert.equal(other.status, 403);
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
});

test('a change counts as a change exactly when the sign-in match rule sees another address', async () => {
  // Die Pruefung muss dieselbe Regel nehmen wie die Pfade, die die Adresse
  // lesen (server/utils/email-match.js): Leerraum und A-Z-Schreibweise sind
  // keine Aenderung, ein Kelvin-Zeichen statt "K" dagegen schon - die
  // Anmeldung sieht darin eine andere Adresse.
  const { bodyChangesContactEmails } = await import('../server/services/contact-identity.js');
  const linked = { email: '\u212Aate@home.test', family_user_id: kidId };
  assert.equal(bodyChangesContactEmails(linked, [], { email: 'kate@home.test' }), true,
    'Kelvin-Zeichen zu K ist fuer die Anmeldung eine andere Adresse');
  assert.equal(bodyChangesContactEmails({ email: 'Kate@Home.test', family_user_id: kidId }, [],
    { email: '\tkate@home.TEST\u00a0' }), false, 'Leerraum und ASCII-Schreibweise bleiben keine Aenderung');
});

test('the linked person can change their own email in a session', async () => {
  const r = await call(kid, 'PUT', `/contacts/${kidContactId}`, {
    email: 'kid.new@home.test', emails: [{ label: 'school', value: 'kid@school.test' }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(emailsOf(kidContactId), { email: 'kid.new@home.test', emails: ['kid@school.test'] });
});

test('an admin can change a member\'s email in a session', async () => {
  const r = await call(admin, 'PUT', `/contacts/${kidContactId}`, { email: 'kid.other@home.test' });
  assert.equal(r.status, 200);
  assert.equal(emailsOf(kidContactId).email, 'kid.other@home.test');
});

test('a member can still change the email of a contact that is not linked to an account', async () => {
  const c = await call(kid, 'POST', '/contacts', { name: 'Plumber', email: 'plumber@example.test' });
  assert.equal(c.status, 201);
  const r = await call(kid, 'PUT', `/contacts/${c.body.data.id}`, { email: 'plumber2@example.test' });
  assert.equal(r.status, 200);
  assert.equal(emailsOf(c.body.data.id).email, 'plumber2@example.test');
});

test('a CardDAV sync that adopts a linked contact leaves its email addresses alone', async () => {
  const accountId = db.prepare(
    "INSERT INTO carddav_accounts (name, carddav_url, username, password) VALUES ('t', 'https://dav.example.test', 'u', 'p')"
  ).run().lastInsertRowid;
  const abUrl = 'https://dav.example.test/abook/';
  const card = [
    'BEGIN:VCARD', 'VERSION:3.0', 'UID:adopt-admin', 'FN:Admin',
    'TEL;TYPE=CELL:+49 30 5550100', `EMAIL;TYPE=HOME:${ATTACKER}`, 'EMAIL;TYPE=WORK:second@attacker.test',
    'ORG:Synced Org', 'END:VCARD',
  ].join('\r\n');
  const id = await parseAndMergeContact(card, accountId, abUrl);
  assert.equal(Number(id), adminContactId, 'the phone match adopts the linked contact');
  // Zweiter Lauf: jetzt ueber die UID, mit fillAll = false.
  await parseAndMergeContact(card, accountId, abUrl);
  assert.deepEqual(emailsOf(adminContactId), ADMIN_UNTOUCHED);
  assert.equal(db.prepare('SELECT organization FROM contacts WHERE id = ?').get(adminContactId).organization, 'Synced Org');
});

// -------------------------------------------------------------------------
// End-to-End: der abgewiesene Versuch fuehrt weder per SSO noch per Reset
// zum Konto. Jeder Test macht seinen Versuch selbst.
// -------------------------------------------------------------------------

test('after a refused attempt, SSO does not link the attacker address to the admin account', async () => {
  const attempt = await call(kid, 'PUT', `/contacts/${adminContactId}`, { emails: [{ label: 'work', value: ATTACKER }] });
  assert.equal(attempt.status, 403);
  const u = findOrCreateOidcUser(db, { sub: 'attacker-sub', email: ATTACKER, email_verified: true });
  assert.notEqual(u?.id, adminId);
  assert.equal(db.prepare('SELECT oidc_sub FROM users WHERE id = ?').get(adminId).oidc_sub, null);
});

test('after a refused attempt, forgot-password sends the admin\'s link to the admin\'s own address only', async () => {
  const attempt = await call(kid, 'PUT', `/contacts/${adminContactId}`, { email: ATTACKER });
  assert.equal(attempt.status, 403);
  await withResetRoutes(async ({ post, sent }) => {
    assert.equal((await post('/forgot-password', { identifier: 'admin' })).status, 200);
    assert.equal((await post('/forgot-password', { identifier: ATTACKER })).status, 200);
    assert.deepEqual(sent.map((m) => m.to), ['admin@home.test']);
  });
});

// -------------------------------------------------------------------------
// Geteilte Ausgaben: ein Konto aus einem Kontakt ist ein Gast
// -------------------------------------------------------------------------

async function contactIntoGroup(name, email) {
  const c = await call(kid, 'POST', '/contacts', { name, email });
  assert.equal(c.status, 201);
  const g = await call(kid, 'POST', '/split-expenses/groups', { name: `Trip ${name}` });
  assert.equal(g.status, 201);
  const m = await call(kid, 'POST', `/split-expenses/groups/${g.body.data.id}/members`, { contact_id: c.body.data.id });
  assert.equal(m.status, 201);
  return { userId: m.body.data.user_id, groupId: g.body.data.id };
}

test('adding a contact to a group creates a split guest, not a household member', async () => {
  const { userId, groupId } = await contactIntoGroup('Grandma', 'grandma@example.test');
  const guest = db.prepare('SELECT group_id, created_by FROM split_expense_guest_users WHERE user_id = ?').get(userId);
  assert.deepEqual(guest, { group_id: groupId, created_by: kidId });
  assert.equal(isHouseholdMember(userId, { db }), false);
  const members = await call(admin, 'GET', '/family/members');
  assert.equal(members.status, 200);
  assert.ok(!members.body.data.some((m) => m.id === userId), 'listed as a household member');
});

test('an account created from a contact with a foreign address hands out nothing beyond its group', async () => {
  // Eine eigene Adresse: ATTACKER traegt seit dem SSO-Test oben ein
  // Haushaltskonto, und eine Adresse, die schon ein anderes Konto traegt, wird
  // seit GHSA-6pmj-w42g-g6qv gar nicht erst zum Gast (test:oidc-email-link).
  const DECOY = 'decoy@attacker.test';
  const { userId } = await contactIntoGroup('Decoy', DECOY);
  const username = db.prepare('SELECT username FROM users WHERE id = ?').get(userId).username;
  const link = await withResetRoutes(async ({ post, sent }) => {
    assert.equal((await post('/forgot-password', { identifier: username })).status, 200);
    return sent.find((m) => m.to === DECOY)?.text.match(/token=([\w-]+)/)?.[1] ?? null;
  });
  // Ein Gast darf sein Passwort zuruecksetzen - das ist gewollt. Wer die
  // Adresse traegt, bekommt damit aber nur den Gast, nicht den Haushalt.
  assert.ok(link, 'the reset link went nowhere - the test would measure nothing');
  await withResetRoutes(async ({ post }) => {
    assert.equal((await post('/reset-password', { token: link, password: 'attackerpass1' })).status, 200);
  });
  const session = await login(username, 'attackerpass1');
  assert.equal(session.status, 200);
  for (const path of ['/tasks', '/contacts', '/family/members']) {
    const r = await call(session, 'GET', path);
    assert.equal(r.status, 403, `${path} reachable for the account created from a contact`);
  }
  assert.equal(isHouseholdMember(userId, { db }), false);
});

// Nach dem Passwort-Hash (dem einzigen await) laeuft alles in EINER
// Transaktion: Gruppe und Kontakt werden dort neu gelesen. Vorher schrieben
// vier Einzelanweisungen nach dem await - verschwand die Gruppe waehrenddessen,
// stand ein Konto samt Verknuepfung da, aber ohne Gast-Zeile: ein volles
// Haushaltsmitglied, und die Anfrage antwortete 500.
test('a group deleted while the account is being prepared leaves no account behind', async () => {
  const c = await call(kid, 'POST', '/contacts', { name: 'Racer', email: ATTACKER });
  assert.equal(c.status, 201);
  const g = await call(kid, 'POST', '/split-expenses/groups', { name: 'Race trip' });
  assert.equal(g.status, 201);
  const add = call(kid, 'POST', `/split-expenses/groups/${g.body.data.id}/members`, { contact_id: c.body.data.id });
  // Die Loeschung soll WAEHREND des Hashs ankommen, nicht davor.
  await new Promise((r) => setTimeout(r, 30));
  const del = await call(kid, 'DELETE', `/split-expenses/groups/${g.body.data.id}`);
  assert.equal(del.status, 200);
  const added = await add;
  assert.equal(added.status, 404, `adding answered ${added.status}`);
  assert.equal(db.prepare('SELECT family_user_id FROM contacts WHERE id = ?').get(c.body.data.id).family_user_id, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE display_name = 'Racer'").get().n, 0);
});

test('two simultaneous additions of the same contact create one account', async () => {
  const c = await call(kid, 'POST', '/contacts', { name: 'Twin', email: 'twin@example.test' });
  assert.equal(c.status, 201);
  const g = await call(kid, 'POST', '/split-expenses/groups', { name: 'Twin trip' });
  assert.equal(g.status, 201);
  const path = `/split-expenses/groups/${g.body.data.id}/members`;
  const [a, b] = await Promise.all([
    call(kid, 'POST', path, { contact_id: c.body.data.id }),
    call(kid, 'POST', path, { contact_id: c.body.data.id }),
  ]);
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.equal(a.body.data.user_id, b.body.data.user_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE display_name = 'Twin'").get().n, 1);
  const linked = db.prepare('SELECT family_user_id FROM contacts WHERE id = ?').get(c.body.data.id).family_user_id;
  assert.equal(linked, a.body.data.user_id);
  assert.ok(db.prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?').get(linked));
});

test('adding a contact that does not exist answers 404 and creates nothing', async () => {
  const g = await call(kid, 'POST', '/split-expenses/groups', { name: 'Ghost trip' });
  assert.equal(g.status, 201);
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const r = await call(kid, 'POST', `/split-expenses/groups/${g.body.data.id}/members`, { contact_id: 999999 });
  assert.equal(r.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before);
});
