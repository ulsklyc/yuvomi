/**
 * Modul: CardDAV-Kontoverwaltung nur fuer Admins
 * Zweck: Die Kontoverwaltung war nur in der Oberflaeche admin-only (`adminOnly`
 *        am Blatt `sync-contacts`). Der Router fragte nur das Modulrecht
 *        `contacts`, das Mitglieder standardmaessig haben, ebenso jedes Token
 *        mit `contacts:write`. Ein PUT mit fremder Adresse und leerem Passwort
 *        behielt das gespeicherte Passwort (`COALESCE(?, password)`), und der
 *        naechste Test oder Sync schickte die Basic-Zugangsdaten des
 *        Haushalts an diesen Host.
 *
 *        Die Suite laeuft durch den ECHTEN Server (test/server-ready.js): ein
 *        nackt eingehaengter Router saehe die Gates aus server/index.js nicht,
 *        und genau deren Zusammenspiel mit dem Router ist die Frage. Ein
 *        lokaler HTTP-Server spielt den fremden Host und schneidet jeden
 *        Authorization-Header mit; gemessen wird der EFFEKT (was dort ankam,
 *        was in der Tabelle steht), nicht nur der Statuscode.
 *
 *        Zwei Riegel, beide einzeln belegt:
 *        1. Jede Route unter /contacts/cardav verlangt Admin (Sitzung und
 *           Token, Rolle des Token-Subjekts).
 *        2. Ein neuer Server (Schema, Host, Port) oder Benutzername braucht
 *           das Passwort neu - auch fuer den Admin.
 * Ausfuehren: node --experimental-sqlite --test test/test-carddav-admin-gate.js
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'carddav-admin-gate',
  env: { SESSION_SECRET: 'test-carddav-admin-gate-secret-min-32' },
});
const db = (await import('../server/db.js')).get();

// Der fremde Host: antwortet immer 401, merkt sich aber jede Anfrage.
const seen = [];
const foreign = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
  res.end();
});
await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
const FOREIGN_URL = `http://127.0.0.1:${foreign.address().port}/dav/`;
after(() => new Promise((resolve) => foreign.close(resolve)));

const HOUSEHOLD_SECRET = 'household-carddav-secret';
const leakedToForeignHost = () => seen.some((r) => r.authorization
  && Buffer.from(r.authorization.replace(/^Basic /, ''), 'base64').toString().includes(HOUSEHOLD_SECRET));

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
const created = await admin('POST', '/auth/users', { username: 'member1', display_name: 'Member', password: 'memberpass123' });
assert.equal(created.status, 201, 'Mitglied angelegt');
const MEMBER_ID = created.body.user.id;
const member = client(await login('member1', 'memberpass123'));

function mintToken(value, subjectId, scopes) {
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id, scopes)
    VALUES (?, ?, 'yuvomi_test', 1, ?, ?)
  `).run(value, crypto.createHash('sha256').update(value).digest('hex'), subjectId, JSON.stringify(scopes));
  return client({ Authorization: `Bearer ${value}` });
}
const memberToken = mintToken('yuvomi_test_member_contacts_write', MEMBER_ID, ['contacts:write']);
const adminToken = mintToken('yuvomi_test_admin_contacts_write', 1, ['contacts:write']);

function seedAccount(tag) {
  const id = db.prepare(`
    INSERT INTO carddav_accounts (name, carddav_url, username, password)
    VALUES ('Haushalt', ?, 'family', ?)
  `).run(`https://dav.example.invalid/${tag}/`, HOUSEHOLD_SECRET).lastInsertRowid;
  const abId = db.prepare(`
    INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
    VALUES (?, ?, 'Familie', 1)
  `).run(id, `https://dav.example.invalid/${tag}/familie/`).lastInsertRowid;
  return { id, abId };
}
const accountRow = (id) => db.prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(id);

for (const [label, as] of [['Mitglied (Sitzung)', member], ['Token eines Mitglieds mit contacts:write', memberToken]]) {
  test(`${label}: kann die Zugangsdaten nicht an einen fremden Host schicken`, async () => {
    const { id } = seedAccount(`leak-${label.length}`);
    seen.length = 0;

    const put = await as('PUT', `/contacts/cardav/accounts/${id}`, { name: 'Haushalt', cardavUrl: FOREIGN_URL, username: 'family' });
    assert.equal(put.status, 403, 'PUT');
    assert.equal(accountRow(id).carddav_url, `https://dav.example.invalid/leak-${label.length}/`, 'Adresse unveraendert');

    // Selbst wenn die Adresse schon fremd waere: Test, Sync und Discovery
    // bleiben dem Mitglied verschlossen.
    // Die fremde Adresse steht nur fuer diese drei Aufrufe in der Tabelle: der
    // Hintergrund-Sync (erster Lauf nach 10 s) soll sie nie zu sehen bekommen.
    db.prepare('UPDATE carddav_accounts SET carddav_url = ? WHERE id = ?').run(FOREIGN_URL, id);
    const statuses = {};
    try {
      for (const action of ['test', 'sync', 'addressbooks/refresh']) {
        statuses[action] = (await as('POST', `/contacts/cardav/accounts/${id}/${action}`)).status;
      }
    } finally {
      db.prepare('DELETE FROM carddav_accounts WHERE id = ?').run(id);
    }
    assert.deepEqual(statuses, { test: 403, sync: 403, 'addressbooks/refresh': 403 });
    assert.equal(seen.length, 0, `der fremde Host sah ${seen.length} Anfragen`);
    assert.equal(leakedToForeignHost(), false, 'Passwort beim fremden Host angekommen');
  });

  test(`${label}: sieht keine Konten und verwaltet keine`, async () => {
    const { id, abId } = seedAccount(`manage-${label.length}`);

    const list = await as('GET', '/contacts/cardav/accounts');
    assert.equal(list.status, 403, 'GET /accounts');
    assert.equal(list.body?.data, undefined, 'keine Kontodaten in der Antwort');
    assert.equal((await as('GET', `/contacts/cardav/accounts/${id}/addressbooks`)).status, 403, 'Adressbuecher auflisten');

    assert.equal((await as('PUT', `/contacts/cardav/addressbooks/${abId}`, { enabled: false })).status, 403, 'Adressbuch umschalten');
    assert.equal(db.prepare('SELECT enabled FROM carddav_addressbook_selection WHERE id = ?').get(abId).enabled, 1, 'Auswahl unveraendert');

    assert.equal((await as('DELETE', `/contacts/cardav/accounts/${id}`)).status, 403, 'DELETE');
    assert.ok(accountRow(id), 'Konto steht noch');

    seen.length = 0;
    const before = db.prepare('SELECT COUNT(*) AS n FROM carddav_accounts').get().n;
    const add = await as('POST', '/contacts/cardav/accounts', { name: 'X', cardavUrl: FOREIGN_URL, username: 'u', password: 'p' });
    assert.equal(add.status, 403, 'POST /accounts');
    assert.equal(seen.length, 0, 'kein Verbindungsversuch beim Anlegen');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM carddav_accounts').get().n, before, 'kein Konto angelegt');
  });
}

test('Mitglied liest seine Kontakte weiter - der Riegel sitzt nur an der Kontoverwaltung', async () => {
  const res = await member('GET', '/contacts');
  assert.equal(res.status, 200);
});

test('Admin-Sitzung und Admin-Token mit contacts:write verwalten weiter', async () => {
  seedAccount('admin-ok');
  for (const as of [admin, adminToken]) {
    const list = await as('GET', '/contacts/cardav/accounts');
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((a) => a.cardavUrl === 'https://dav.example.invalid/admin-ok/'), 'Konto gelistet');
    assert.ok(list.body.data.every((a) => !('password' in a)), 'kein Passwort in der Liste');
  }
});

test('Neuer Server ohne neues Passwort: 400 password_required, nichts geschrieben, nichts gesendet', async () => {
  const { id } = seedAccount('admin-host');
  seen.length = 0;
  const put = await admin('PUT', `/contacts/cardav/accounts/${id}`, { name: 'Haushalt', cardavUrl: FOREIGN_URL, username: 'family', password: '' });
  assert.equal(put.status, 400);
  assert.equal(put.body.errorCode, 'password_required');
  assert.equal(accountRow(id).carddav_url, 'https://dav.example.invalid/admin-host/', 'Adresse unveraendert');
  assert.equal(accountRow(id).password, HOUSEHOLD_SECRET, 'Passwort unveraendert');
  assert.equal(seen.length, 0, 'kein Verbindungsversuch');
});

test('Anderer Port oder anderes Schema zaehlt als neuer Server', async () => {
  const { id } = seedAccount('admin-port');
  for (const url of ['https://dav.example.invalid:8443/admin-port/', 'http://dav.example.invalid/admin-port/']) {
    const put = await admin('PUT', `/contacts/cardav/accounts/${id}`, { name: 'Haushalt', cardavUrl: url, username: 'family' });
    assert.equal(put.status, 400, url);
    assert.equal(put.body.errorCode, 'password_required', url);
  }
});

test('Neuer Benutzername ohne neues Passwort: 400 password_required', async () => {
  const { id } = seedAccount('admin-user');
  const put = await admin('PUT', `/contacts/cardav/accounts/${id}`, { name: 'Haushalt', cardavUrl: 'https://dav.example.invalid/admin-user/', username: 'someone-else' });
  assert.equal(put.status, 400);
  assert.equal(put.body.errorCode, 'password_required');
  assert.equal(accountRow(id).username, 'family', 'Benutzer unveraendert');
});

test('Derselbe Server, anderer Pfad oder Schreibweise: Passwort bleibt, ohne neu einzugeben', async () => {
  const { id } = seedAccount('admin-path');
  for (const url of ['https://dav.example.invalid/other-path/', 'https://DAV.example.invalid:443/other-path/']) {
    const put = await admin('PUT', `/contacts/cardav/accounts/${id}`, { name: 'Haushalt', cardavUrl: url, username: 'family' });
    assert.equal(put.status, 200, url);
    assert.equal(accountRow(id).carddav_url, url);
    assert.equal(accountRow(id).password, HOUSEHOLD_SECRET, 'Passwort behalten');
  }
});

test('Neuer Server MIT neuem Passwort: wird gespeichert', async () => {
  const { id } = seedAccount('admin-move');
  const put = await admin('PUT', `/contacts/cardav/accounts/${id}`, { name: 'Haushalt', cardavUrl: 'https://new.example.invalid/dav/', username: 'family2', password: 'new-secret' });
  assert.equal(put.status, 200);
  const row = accountRow(id);
  assert.equal(row.carddav_url, 'https://new.example.invalid/dav/');
  assert.equal(row.username, 'family2');
  assert.equal(row.password, 'new-secret');
});
