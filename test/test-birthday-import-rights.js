/**
 * Test: Ein Kontakt in die Geburtstage - die Rechte des Imports (#2149)
 * Zweck: Die Leseansicht eines Kontakts bietet "Zu Geburtstagen hinzufuegen"
 *        an und ruft dafuer den BESTEHENDEN Import mit genau einer id
 *        (`POST /birthdays/import`, keine zweite Logik). Diese Suite misst,
 *        was die Oberflaeche dabei voraussetzt:
 *          - ohne Schreibrecht auf `calendar` (dem `/birthdays` gehoert) legt
 *            der Aufruf nichts an - 403 und keine Zeile;
 *          - ein Kind (Startrechte) und gemischte Token-Scopes: es braucht
 *            BEIDE Achsen, `calendar:write` und `contacts:read`;
 *          - doppeltes Anlegen ist idempotent (eine Zeile, `skipped`);
 *          - danach traegt der Kontakt `birthday_id` auf `GET /contacts/:id`,
 *            den Wert, den die Ansicht neu liest.
 *
 * WARUM DER ECHTE SERVER: das Schreibrecht auf `calendar` prueft das Gate in
 * server/index.js am Pfad, nicht die Route. Ein selbst eingehaengter Router
 * saehe es nie (test-display-account.js, Kopf).
 *
 * Ausfuehren: npm run test:birthday-import-rights
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'birthday-import-rights',
  env: { SESSION_SECRET: 'test-birthday-import-rights-secret-min32' },
});
const db = (await import('../server/db.js')).get();

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { Cookie: cookie, 'X-CSRF-Token': me.csrfToken };
}

function client(authHeaders) {
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const admin = client(await login('admin', 'adminpass123'));

async function createUser(username, extra = {}) {
  const res = await admin('POST', '/auth/users', { username, display_name: username, password: `${username}-pass123`, ...extra });
  assert.equal(res.status, 201, `${username} angelegt`);
  return { id: res.body.user.id, as: client(await login(username, `${username}-pass123`)) };
}

const member = await createUser('member1');
const child = await createUser('kind1', { family_role: 'child' });

/** Mitgliedsrechte, wie das Rechte-Blatt sie schreibt. */
function setModules(userId, modules) {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ? AND resource_type = 'module' AND resource_key IN ('calendar', 'contacts')")
    .run(String(userId));
  const ins = db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, ?)
  `);
  for (const [key, level] of Object.entries(modules)) ins.run(String(userId), key, level);
}

let tokenCounter = 0;
function mintToken(subjectId, scopes) {
  tokenCounter += 1;
  const value = `yuvomi_test_bdimport_${tokenCounter}`;
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id, scopes)
    VALUES (?, ?, 'yuvomi_test', 1, ?, ?)
  `).run(value, crypto.createHash('sha256').update(value).digest('hex'), subjectId, JSON.stringify(scopes));
  return client({ Authorization: `Bearer ${value}` });
}

let contactCounter = 0;
async function seedContact() {
  contactCounter += 1;
  const res = await admin('POST', '/contacts', { name: `Probe ${contactCounter}`, category: 'misc', birthday: '1970-05-04' });
  assert.equal(res.status, 201, 'Kontakt angelegt');
  return res.body.data.id;
}
const linkedRows = (contactId) => db.prepare('SELECT id FROM birthdays WHERE contact_id = ?').all(contactId);

test('Vorbedingung: das Mitglied mit vollem Recht legt den Eintrag an, und der Kontakt kennt ihn danach', async () => {
  setModules(member.id, {});
  const cid = await seedContact();
  assert.equal((await member.as('GET', `/contacts/${cid}`)).body.data.birthday_id, null, 'vorher unverknuepft');

  const res = await member.as('POST', '/birthdays/import', { contact_ids: [cid] });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.data, { imported: 1, skipped: 0 });
  const rows = linkedRows(cid);
  assert.equal(rows.length, 1);
  assert.equal((await member.as('GET', `/contacts/${cid}`)).body.data.birthday_id, rows[0].id,
    'GET /contacts/:id traegt die Verknuepfung, die die Ansicht neu liest');
});

test('doppeltes Anlegen ist idempotent: eine Zeile, der zweite Aufruf ueberspringt', async () => {
  setModules(member.id, {});
  const cid = await seedContact();
  assert.equal((await member.as('POST', '/birthdays/import', { contact_ids: [cid] })).status, 201);
  const again = await member.as('POST', '/birthdays/import', { contact_ids: [cid] });
  assert.equal(again.status, 201);
  assert.deepEqual(again.body.data, { imported: 0, skipped: 1 });
  assert.equal(linkedRows(cid).length, 1, 'kein zweiter Eintrag');
});

test('ohne Schreibrecht auf den Kalender: 403 und kein Eintrag', async () => {
  for (const level of ['read', 'none']) {
    setModules(member.id, { calendar: level });
    const cid = await seedContact();
    const res = await member.as('POST', '/birthdays/import', { contact_ids: [cid] });
    assert.equal(res.status, 403, `calendar: ${level}`);
    assert.equal(linkedRows(cid).length, 0, `calendar: ${level} - nichts angelegt`);
  }
  setModules(member.id, {});
});

test('ohne Kontakte-Leserecht: 403 und kein Eintrag, auch mit Kalender-Schreibrecht', async () => {
  setModules(member.id, { calendar: 'write', contacts: 'none' });
  const cid = await seedContact();
  const res = await member.as('POST', '/birthdays/import', { contact_ids: [cid] });
  assert.equal(res.status, 403);
  assert.equal(linkedRows(cid).length, 0);
  setModules(member.id, {});
});

test('ein Kind: mit seinen Startrechten legt es an, mit calendar: read nicht', async () => {
  setModules(child.id, {});
  const ok = await seedContact();
  assert.equal((await child.as('POST', '/birthdays/import', { contact_ids: [ok] })).status, 201);
  assert.equal(linkedRows(ok).length, 1);

  setModules(child.id, { calendar: 'read' });
  const denied = await seedContact();
  assert.equal((await child.as('POST', '/birthdays/import', { contact_ids: [denied] })).status, 403);
  assert.equal(linkedRows(denied).length, 0);
  setModules(child.id, {});
});

test('gemischte Token-Scopes: es braucht calendar:write UND contacts:read', async () => {
  setModules(member.id, {});
  const cases = [
    [['calendar:write'], 403],
    [['contacts:read', 'calendar:read'], 403],
    [['contacts:write'], 403],
    [['contacts:read', 'calendar:write'], 201],
  ];
  for (const [scopes, status] of cases) {
    const cid = await seedContact();
    const res = await mintToken(member.id, scopes)('POST', '/birthdays/import', { contact_ids: [cid] });
    assert.equal(res.status, status, `Scopes ${scopes.join(',')}`);
    assert.equal(linkedRows(cid).length, status === 201 ? 1 : 0, `Scopes ${scopes.join(',')}: Zeilen`);
  }
});
