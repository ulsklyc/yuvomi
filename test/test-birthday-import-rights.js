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

// --------------------------------------------------------
// Verknuepfen im Geburtstag-Dialog (Critique R22, D7): POST/PUT nehmen
// `contact_id`. Bis R22 entstand die Verknuepfung nur ueber den Import.
// --------------------------------------------------------

async function seedBirthday(name, extra = {}) {
  const res = await admin('POST', '/birthdays', { name, birth_date: '1980-02-03', ...extra });
  assert.equal(res.status, 201, `Geburtstag ${name} angelegt`);
  return res.body.data;
}
const linkOf = (birthdayId) => db.prepare('SELECT contact_id FROM birthdays WHERE id = ?').get(birthdayId)?.contact_id ?? null;

test('D7: POST mit contact_id verknuepft, und der Kontakt fuehrt den Weg zurueck samt Datum', async () => {
  setModules(member.id, {});
  const contact = await admin('POST', '/contacts', { name: 'Link Ohne Datum', category: 'misc' });
  const cid = contact.body.data.id;
  const res = await member.as('POST', '/birthdays', { name: 'Link Ohne Datum', birth_date: '1975-07-08', contact_id: cid });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.contact_id, cid, 'die Antwort traegt die Verknuepfung');
  const back = (await member.as('GET', `/contacts/${cid}`)).body.data;
  assert.equal(back.birthday_id, res.body.data.id, 'der Kontakt kennt seinen Geburtstag');
  assert.equal(back.birthday, null, 'das Datum des Kontakts bleibt unberuehrt (#2124 nicht gebaut)');
  assert.equal(back.birthday_link_date, '1975-07-08', 'die Zeile zeigt das Datum des verknuepften Eintrags');
});

test('D7: PUT verknuepft einen bestehenden Geburtstag; derselbe Wert geht durch, null loest', async () => {
  setModules(member.id, {});
  const cid = await seedContact();
  const birthday = await seedBirthday('Spaeter Verknuepft');
  assert.equal(linkOf(birthday.id), null);
  const linked = await member.as('PUT', `/birthdays/${birthday.id}`, { contact_id: cid });
  assert.equal(linked.status, 200);
  assert.equal(linkOf(birthday.id), cid);
  const same = await member.as('PUT', `/birthdays/${birthday.id}`, { notes: 'x', contact_id: cid });
  assert.equal(same.status, 200, 'der gespeicherte Wert ist kein Konflikt mit sich selbst');
  const untouched = await member.as('PUT', `/birthdays/${birthday.id}`, { notes: 'y' });
  assert.equal(untouched.status, 200);
  assert.equal(linkOf(birthday.id), cid, 'ohne Feld bleibt die Verknuepfung');
  const unlinked = await member.as('PUT', `/birthdays/${birthday.id}`, { contact_id: null });
  assert.equal(unlinked.status, 200);
  assert.equal(linkOf(birthday.id), null);
});

test('D7: ein schon verknuepfter Kontakt -> 409 mit Grund, nichts geschrieben', async () => {
  setModules(member.id, {});
  const cid = await seedContact();
  const first = await seedBirthday('Erster', { contact_id: cid });
  const second = await seedBirthday('Zweiter');
  const res = await member.as('PUT', `/birthdays/${second.id}`, { contact_id: cid, notes: 'soll nicht landen' });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'birthdays_contact_linked');
  assert.equal(linkOf(second.id), null);
  assert.equal(linkOf(first.id), cid, 'der erste bleibt verknuepft');
  assert.equal(db.prepare('SELECT notes FROM birthdays WHERE id = ?').get(second.id).notes, null, 'auch die anderen Felder nicht');
  const post = await member.as('POST', '/birthdays', { name: 'Dritter', birth_date: '1990-01-01', contact_id: cid });
  assert.equal(post.status, 409);
  assert.equal(post.body.reason, 'birthdays_contact_linked');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM birthdays WHERE name = 'Dritter'").get().n, 0, 'kein Eintrag angelegt');
});

/*
 * DER WETTLAUF UEBER DEN INDEX. Die Vorabpruefung (`checkContactLink`) und das
 * Schreiben liegen ohne await hintereinander - im selben Prozess kommt kein
 * Request dazwischen. Ein zweiter Prozess an derselben Datei (oder ein Weg,
 * der die Vorabpruefung umgeht) kann den Kontakt aber zwischen Pruefen und
 * Schreiben verknuepfen; dann haelt nur der eindeutige Index aus Migration 90,
 * und die Route muss aus SQLITE_CONSTRAINT_UNIQUE dieselbe 409 machen statt
 * einer 500.
 *
 * Nachgestellt mit einem TEMP-Trigger auf der Verbindung des Servers: er
 * verknuepft den Rivalen im selben Augenblick, in dem die Route schreibt -
 * NACH ihrer Pruefung, VOR dem Index. Die Pruefung sah den Kontakt frei.
 */
function withRivalLink(sql, fn) {
  db.exec(sql);
  return Promise.resolve().then(fn).finally(() => db.exec('DROP TRIGGER IF EXISTS temp.race_link'));
}

test('D7: Wettlauf - der Index faengt den Doppelgriff bei POST, Antwort 409 statt 500', async () => {
  setModules(member.id, {});
  const cid = await seedContact();
  const rival = await seedBirthday('Rivale POST');
  const res = await withRivalLink(`
    CREATE TEMP TRIGGER race_link BEFORE INSERT ON main.birthdays WHEN NEW.contact_id = ${Number(cid)}
    BEGIN UPDATE main.birthdays SET contact_id = NEW.contact_id WHERE id = ${Number(rival.id)}; END;
  `, () => member.as('POST', '/birthdays', { name: 'Zu Spaet POST', birth_date: '1990-01-01', contact_id: cid }));
  assert.equal(res.status, 409, `Index-Konflikt wird 409, nicht ${res.status}`);
  assert.equal(res.body.reason, 'birthdays_contact_linked');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM birthdays WHERE name = 'Zu Spaet POST'").get().n, 0, 'kein Eintrag angelegt');
  // Gegenprobe: ohne den Rivalen geht derselbe Aufruf durch - der Trigger,
  // nicht die Vorabpruefung, hat die 409 ausgeloest.
  const free = await member.as('POST', '/birthdays', { name: 'Rechtzeitig POST', birth_date: '1990-01-01', contact_id: cid });
  assert.equal(free.status, 201);
});

test('D7: Wettlauf - der Index faengt den Doppelgriff bei PUT, Antwort 409, nichts geschrieben', async () => {
  setModules(member.id, {});
  const cid = await seedContact();
  const rival = await seedBirthday('Rivale PUT');
  const target = await seedBirthday('Ziel PUT');
  const res = await withRivalLink(`
    CREATE TEMP TRIGGER race_link BEFORE UPDATE OF contact_id ON main.birthdays
      WHEN NEW.contact_id = ${Number(cid)} AND NEW.id = ${Number(target.id)}
    BEGIN UPDATE main.birthdays SET contact_id = NEW.contact_id WHERE id = ${Number(rival.id)}; END;
  `, () => member.as('PUT', `/birthdays/${target.id}`, { contact_id: cid, notes: 'soll nicht landen' }));
  assert.equal(res.status, 409, `Index-Konflikt wird 409, nicht ${res.status}`);
  assert.equal(res.body.reason, 'birthdays_contact_linked');
  assert.equal(linkOf(target.id), null);
  assert.equal(db.prepare('SELECT notes FROM birthdays WHERE id = ?').get(target.id).notes, null, 'auch die anderen Felder nicht');
  const free = await member.as('PUT', `/birthdays/${target.id}`, { contact_id: cid });
  assert.equal(free.status, 200);
  assert.equal(linkOf(target.id), cid);
});

test('D7: unbekannter Kontakt -> 400 birthdays_selected_contact_not_found; keine Zahl -> 400', async () => {
  setModules(member.id, {});
  const birthday = await seedBirthday('Ins Leere');
  const gone = await member.as('PUT', `/birthdays/${birthday.id}`, { contact_id: 999999 });
  assert.equal(gone.status, 400);
  assert.equal(gone.body.reason, 'birthdays_selected_contact_not_found');
  const junk = await member.as('PUT', `/birthdays/${birthday.id}`, { contact_id: 'abc' });
  assert.equal(junk.status, 400);
  assert.equal(linkOf(birthday.id), null);
});

test('D7: ohne Kontakte-Leserecht verknuepft niemand - Rolle und Token-Scope', async () => {
  setModules(member.id, { calendar: 'write', contacts: 'none' });
  const cid = await seedContact();
  const birthday = await seedBirthday('Ohne Adressbuch');
  const res = await member.as('PUT', `/birthdays/${birthday.id}`, { contact_id: cid });
  assert.equal(res.status, 403);
  assert.equal(linkOf(birthday.id), null);
  const post = await member.as('POST', '/birthdays', { name: 'Ohne Adressbuch 2', birth_date: '1990-01-01', contact_id: cid });
  assert.equal(post.status, 403);
  setModules(member.id, {});
  const scoped = await mintToken(member.id, ['calendar:write'])('PUT', `/birthdays/${birthday.id}`, { contact_id: cid });
  assert.equal(scoped.status, 403, 'calendar:write allein reicht nicht');
  const both = await mintToken(member.id, ['calendar:write', 'contacts:read'])('PUT', `/birthdays/${birthday.id}`, { contact_id: cid });
  assert.equal(both.status, 200);
  assert.equal(linkOf(birthday.id), cid);
});

test('D7: Mitglieder-Geburtstage sind ausgenommen', async () => {
  setModules(member.id, {});
  const cid = await seedContact();
  const id = db.prepare("INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES ('Mitglied', '1980-01-01', 1, ?)")
    .run(member.id).lastInsertRowid;
  const res = await admin('PUT', `/birthdays/${id}`, { contact_id: cid });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'birthdays_member_not_linkable');
  assert.equal(linkOf(id), null);
  db.prepare('DELETE FROM birthdays WHERE id = ?').run(id);
});

test('D7: gleicher Name ohne Verknuepfung -> suggested_contact_id, nur eindeutig und nur mit Kontakte-Recht', async () => {
  setModules(member.id, {});
  const contact = await admin('POST', '/contacts', { name: 'Onkel Probe', category: 'misc' });
  const birthday = await seedBirthday('onkel probe ');
  const find = async (as) => (await as('GET', '/birthdays')).body.data.find((b) => b.id === birthday.id);
  assert.equal((await find(member.as)).suggested_contact_id, contact.body.data.id, 'Name ohne Gross/Klein und Rand');

  setModules(member.id, { contacts: 'none' });
  assert.equal((await find(member.as)).suggested_contact_id, undefined, 'ohne Kontakte-Recht kein Hinweis');
  setModules(member.id, {});

  const twin = await admin('POST', '/contacts', { name: 'Onkel Probe', category: 'misc' });
  assert.equal((await find(member.as)).suggested_contact_id, undefined, 'zwei gleichnamige Kontakte: kein Vorschlag');
  await admin('DELETE', `/contacts/${twin.body.data.id}`);

  await member.as('PUT', `/birthdays/${birthday.id}`, { contact_id: contact.body.data.id });
  const linked = await find(member.as);
  assert.equal(linked.suggested_contact_id, undefined, 'verknuepft: kein Hinweis mehr');
  assert.equal(linked.contact_name, 'Onkel Probe', 'der Dialog kann die Auswahl beschriften');
  setModules(member.id, { contacts: 'none' });
  assert.equal((await find(member.as)).contact_name, undefined, 'ohne Kontakte-Recht kein Name');
  setModules(member.id, {});
});

test('D7: der Hinweis steht auch im Kontakt - suggested_birthday_id, nur eindeutig, nur mit Kalender-Recht', async () => {
  setModules(member.id, {});
  const contact = await admin('POST', '/contacts', { name: 'Tante Gegenprobe', category: 'misc' });
  const cid = contact.body.data.id;
  const birthday = await seedBirthday(' tante gegenprobe');
  const read = async () => (await member.as('GET', `/contacts/${cid}`)).body.data;
  assert.equal((await read()).suggested_birthday_id, birthday.id, 'Name ohne Gross/Klein und Rand');
  // Beide Seiten nennen dasselbe Paar.
  const fromBirthday = (await member.as('GET', '/birthdays')).body.data.find((b) => b.id === birthday.id);
  assert.equal(fromBirthday.suggested_contact_id, cid);
  // Die Antwort auf das Speichern traegt ihn auch: die Ansicht zeichnet danach neu.
  const saved = await admin('PUT', `/contacts/${cid}`, { name: 'Tante Gegenprobe', category: 'misc', notes: 'x' });
  assert.equal(saved.body.data.suggested_birthday_id, birthday.id);

  setModules(member.id, { calendar: 'none' });
  assert.equal((await read()).suggested_birthday_id, undefined, 'ohne Kalender-Recht kein Hinweis');
  setModules(member.id, {});

  const twin = await seedBirthday('Tante Gegenprobe');
  assert.equal((await read()).suggested_birthday_id, undefined, 'zwei gleichnamige Geburtstage: kein Vorschlag');
  await admin('DELETE', `/birthdays/${twin.id}`);

  const memberDay = db.prepare("INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES ('Tante Gegenprobe', '1980-01-01', 1, ?)")
    .run(member.id).lastInsertRowid;
  assert.equal((await read()).suggested_birthday_id, birthday.id, 'ein Mitglieder-Geburtstag zaehlt nicht mit');
  db.prepare('DELETE FROM birthdays WHERE id = ?').run(memberDay);

  await member.as('PUT', `/birthdays/${birthday.id}`, { contact_id: cid });
  const linked = await read();
  assert.equal(linked.suggested_birthday_id, undefined, 'verknuepft: kein Hinweis mehr');
  assert.equal(linked.birthday_id, birthday.id);
});

test('D7: gleicher Name mit Umlaut am Anfang - beide Seiten finden das Paar', async () => {
  // SQLite senkt nur ASCII: "Özlem" und "özlem" waren fuer den Geburtstag zwei
  // Namen, solange der Kontaktname in SQL verglichen wurde. Dazu NFC: CardDAV
  // liefert ein "é" auch zerlegt.
  setModules(member.id, {});
  const contact = await admin('POST', '/contacts', { name: 'ÖZLEM René', category: 'misc' });
  const cid = contact.body.data.id;
  const birthday = await seedBirthday('özlem Rene\u0301');
  const fromBirthday = (await member.as('GET', '/birthdays')).body.data.find((b) => b.id === birthday.id);
  assert.equal(fromBirthday.suggested_contact_id, cid, 'der Geburtstag findet den Kontakt');
  assert.equal((await member.as('GET', `/contacts/${cid}`)).body.data.suggested_birthday_id, birthday.id, 'und umgekehrt');
});

test('D7: die Kandidatenliste nennt auch Kontakte ohne Datum mit ihrer Verknuepfung', async () => {
  setModules(member.id, {});
  const contact = await admin('POST', '/contacts', { name: 'Ohne Datum Kandidat', category: 'misc' });
  const cid = contact.body.data.id;
  const pick = async () => (await member.as('GET', '/birthdays/import/candidates')).body.data.withoutBirthday.find((c) => c.id === cid);
  assert.equal((await pick()).already_imported, false);
  await seedBirthday('Kandidat Verknuepft', { contact_id: cid });
  assert.equal((await pick()).already_imported, true);
});
