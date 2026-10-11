/**
 * Test: ein gespiegelter CalDAV-Termin gehört zu einem Konto (#1860).
 *
 * Bis hierher war die UID die ganze Identität eines Termins, über alle
 * CalDAV-Konten hinweg: lieferte ein zweites Konto dieselbe UID, übernahm es
 * die Zeile des ersten, und welches Konto eine Bearbeitung oder Löschung
 * sendet, ergab sich erst zur Laufzeit aus Kalender-URL und Objektadresse.
 * Jetzt steht das Konto in der Zeile (`calendar_events.caldav_account_id`,
 * Migration 238) und am Löschauftrag.
 *
 * Die Regeln, die hier geprüft werden:
 *   - EINE Zeile je UID. Sie gehört dem Konto, das sie zuerst gebracht hat;
 *     ein zweites Konto mit derselben UID ändert, übernimmt und entfernt sie
 *     nicht. Fällt das besitzende Konto weg oder liefert es die UID nicht
 *     mehr, übernimmt bzw. legt das zweite beim nächsten Abruf an.
 *   - Gesendet wird nur über das Konto der Zeile bzw. des Löschauftrags, im
 *     Sync-Lauf wie im Sofortversuch, und nur an den Server dieses Kontos.
 *   - Eine Zeile ohne Konto wird nie gesendet. Das erste Konto, das ihre UID
 *     liefert, übernimmt sie, wenn nichts an ihr wartet und sie nicht für ein
 *     anderes Konto bestimmt ist.
 *   - Ein Upload-Ziel ist ein Paar (Konto, Kalender) aus der eingeschalteten
 *     Auswahl; alles andere lehnt die Route ab, und ein gespeichertes Altziel
 *     wird nicht hochgeladen.
 *
 * Echte Dienste, echter tsdav-Client, echtes HTTP gegen die Server aus
 * test/caldav-fake-server.js. Welches Konto eine Anfrage gestellt hat, liest
 * der Test aus ihrem Authorization-Kopf, also aus dem, was beim Server ankam -
 * nicht aus der Buchführung, die er prüft.
 *
 * Ausführen: npm run test:caldav-event-account
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const caldavSync = await import('../server/services/caldav-sync.js');
const outbound = await import('../server/services/calendar-outbound.js');
const { createCalDAVClient } = await import('../server/utils/caldav-client.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { retitleBirthdayEvents } = await import('../server/services/birthdays.js');

const userId = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')"
).run().lastInsertRowid);

// a, b: je ein Konto. moved: der Server, auf den ein Konto umzieht.
// foreign: ein Server, zu dem kein Konto gehört.
const servers = {
  a: await startFakeDavServer(), b: await startFakeDavServer(),
  moved: await startFakeDavServer(), foreign: await startFakeDavServer(),
};
test.after(() => Promise.all(Object.values(servers).map((s) => s.close())));

const UID = 'oikos-7@oikos.local';

// ── Fixtures ────────────────────────────────────────────────────────────────────

function vevent(uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T090000Z', `SUMMARY:${summary}`,
    'DTSTART:20350310T090000Z', 'DTEND:20350310T100000Z', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

function reset() {
  for (const table of [
    'calendar_pending_deletions', 'calendar_events', 'external_calendars',
    'caldav_calendar_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  for (const dav of Object.values(servers)) dav.reset();
}

/** Ein Konto auf einem Server, mit einem eingeschalteten Kalender `family`. */
function account(dav, user, { password = 'p' } = {}) {
  const accountId = Number(db.prepare(
    'INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES (?, ?, ?, ?)'
  ).run(`Konto ${user}`, dav.url, user, password).lastInsertRowid);
  const url = `${dav.origin}/cal/family/`;
  if (!dav.objectNames(url).length && !dav.getObject(url, 'neighbour.ics')) {
    dav.addCollection('family', { name: 'Familie' });
    // Der Prune lässt einen Kalender in Ruhe, der gar nichts liefert.
    dav.putObject(url, 'neighbour.ics', vevent(`neighbour-${user}@test`, 'Nachbar'));
  }
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Familie', '#4A90E2', 1)
  `).run(accountId, url);
  return { dav, user, password, accountId, url, objectUrl: `${url}shared.ics` };
}

/**
 * Zwei Konten auf zwei Servern, jedes mit einem Objekt DERSELBEN UID. Konto A
 * hat die kleinere ID und läuft im Sync zuerst.
 */
function twoAccounts() {
  reset();
  const a = account(servers.a, 'user-a');
  const b = account(servers.b, 'user-b');
  a.dav.putObject(a.url, 'shared.ics', vevent(UID, 'Aus A'));
  b.dav.putObject(b.url, 'shared.ics', vevent(UID, 'Aus B'));
  return { a, b };
}

/** Zwei Konten (zwei Benutzer) auf EINEM Server, beide mit demselben Kalender. */
function twoUsersOneCalendar() {
  reset();
  const a = account(servers.a, 'user-a');
  const b = account(servers.a, 'user-b');
  a.dav.putObject(a.url, 'shared.ics', vevent(UID, 'Geteilt'));
  return { a, b };
}

function calendarRef(url) {
  db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav', ?, 'Familie', '#4A90E2')
    ON CONFLICT(source, external_id) DO NOTHING
  `).run(url);
  return db.prepare("SELECT id FROM external_calendars WHERE source = 'caldav' AND external_id = ?").get(url).id;
}

/** Eine gespiegelte Zeile, wie der Abruf sie hinterlässt. `owner: null` = ohne Konto. */
function mirror(acc, { owner = acc.accountId, title = 'Lokal', uid = UID, objectUrl = acc.objectUrl, withCalendar = true, fields = {} } = {}) {
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source,
       external_calendar_id, calendar_ref_id, external_object_url, caldav_account_id)
    VALUES (?, '2035-03-10T10:00', '2035-03-10T11:00', 0, ?, 'caldav', ?, ?, ?, ?)
  `).run(title, userId, uid, withCalendar ? calendarRef(acc.url) : null, objectUrl, owner).lastInsertRowid);
  for (const [column, value] of Object.entries(fields)) {
    db.prepare(`UPDATE calendar_events SET ${column} = ? WHERE id = ?`).run(value, id);
  }
  return id;
}

const row = (id) => db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
const rowsWithUid = (uid = UID) => db.prepare('SELECT * FROM calendar_events WHERE external_calendar_id = ? ORDER BY id').all(uid);
const tombstoneCount = () => db.prepare('SELECT COUNT(*) AS n FROM calendar_pending_deletions').get().n;

function edit(id, title) {
  db.prepare('UPDATE calendar_events SET title = ?, outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?').run(title, id);
}

function tombstone(acc, { owner = acc.accountId, calendarUrl = acc.url, objectUrl = acc.objectUrl, uid = UID } = {}) {
  return Number(db.prepare(`
    INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url, caldav_account_id)
    VALUES ('caldav', ?, ?, ?, ?)
  `).run(calendarUrl, uid, objectUrl, owner).lastInsertRowid);
}

/** Das Konto (sein Benutzername), unter dem eine Anfrage beim Server ankam. */
function senderOf(request) {
  const [scheme, value] = String(request.headers.authorization || '').split(' ');
  if (scheme !== 'Basic') return { user: null };
  return { user: Buffer.from(value, 'base64').toString('utf8').split(':')[0] };
}

const describe = (request) => `${request.method} ${request.path} (${senderOf(request).user})`;

/** Jeder Server sieht nur Anfragen seines eigenen Kontos. */
function assertRequestsStayWithTheirAccount(accounts) {
  for (const acc of Object.values(accounts)) {
    assert.deepEqual(
      acc.dav.requests.filter((r) => senderOf(r).user !== acc.user).map(describe), [],
      `beim Server von ${acc.user} kamen Anfragen eines anderen Kontos an`
    );
  }
}

/** Schreibende Anfragen (PUT, DELETE), die bei einem Server ankamen. */
const writesAt = (dav) => dav.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE');
const summaryAt = (acc, filename = 'shared.ics') => /SUMMARY:(.*)/.exec(acc.dav.getObject(acc.url, filename)?.data ?? '')?.[1]?.trim() ?? null;

/** Meldungen eines Logs während `run`. */
async function logged(t, run) {
  const lines = [];
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => { lines.push({ level, text: args.map(String).join(' ') }); });
  }
  try { await run(); } finally { t.mock.restoreAll(); }
  return lines;
}

// ── 1: dieselbe UID in zwei Konten ──────────────────────────────────────────────

test('dieselbe UID in zwei Konten: eine Zeile, sie gehört dem ersten Konto, und das zweite fasst sie nicht an', async () => {
  const accounts = twoAccounts();
  await caldavSync.sync();

  let rows = rowsWithUid();
  assert.equal(rows.length, 1, `aus derselben UID in zwei Konten wurde(n) ${rows.length} Zeile(n)`);
  const id = rows[0].id;
  assert.equal(rows[0].title, 'Aus A', 'das zweite Konto hat die Zeile des ersten überschrieben');
  assert.equal(rows[0].external_object_url, accounts.a.objectUrl);
  assert.equal(rows[0].caldav_account_id, accounts.a.accountId, 'die Zeile gehört nicht dem Konto, das sie zuerst gebracht hat');

  // Das zweite Konto ändert sein Objekt: die Zeile des ersten bleibt.
  accounts.b.dav.putObject(accounts.b.url, 'shared.ics', vevent(UID, 'Aus B, geändert'));
  await caldavSync.sync();
  rows = rowsWithUid();
  assert.deepEqual(rows.map((r) => r.id), [id], 'der Folgelauf hat eine Zeile angelegt oder ersetzt');
  assert.equal(rows[0].title, 'Aus A');
  assert.equal(rows[0].caldav_account_id, accounts.a.accountId);
  assert.equal(rows[0].external_object_url, accounts.a.objectUrl);
  assert.equal(rows[0].calendar_ref_id, calendarRef(accounts.a.url));
  assertRequestsStayWithTheirAccount(accounts);
});

test('dieselbe UID in zwei Konten: fällt sie im zweiten Konto weg, bleibt die Zeile des ersten', async () => {
  const accounts = twoUsersOneCalendar();
  const id = mirror(accounts.a, { title: 'Geteilt' });
  // Beide Konten lesen denselben Kalender; nur für das zweite fehlt das Objekt.
  const createClient = async (acc) => {
    const client = await createCalDAVClient(acc);
    if (acc.id !== accounts.b.accountId) return client;
    return Object.assign(Object.create(client), {
      fetchCalendarObjects: async (params) => (await client.fetchCalendarObjects(params))
        .filter((obj) => !String(obj.data).includes(UID)),
    });
  };

  await caldavSync.sync({ createClient });

  assert.equal(row(id)?.caldav_account_id, accounts.a.accountId, 'der Lauf des zweiten Kontos hat die Zeile des ersten entfernt');
});

for (const owner of ['a', 'b']) {
  test(`dieselbe UID in zwei Konten: eine Bearbeitung geht im Sync-Lauf nur über das besitzende Konto (${owner.toUpperCase()})`, async () => {
    const accounts = twoAccounts();
    const other = owner === 'a' ? 'b' : 'a';
    const id = mirror(accounts[owner], { title: 'Vorher' });
    edit(id, 'Bearbeitet');

    await caldavSync.sync();

    assertRequestsStayWithTheirAccount(accounts);
    assert.equal(summaryAt(accounts[owner]), 'Bearbeitet', 'die Bearbeitung kam im besitzenden Konto nicht an');
    assert.equal(summaryAt(accounts[other]), `Aus ${other.toUpperCase()}`, 'das Objekt des anderen Kontos wurde überschrieben');
    assert.deepEqual(writesAt(accounts[other].dav).map(describe), [], 'das andere Konto hat geschrieben');
    assert.equal(row(id).outbound_dirty, 0);
    assert.equal(row(id).title, 'Bearbeitet', 'der Abruf des anderen Kontos hat die Zeile überschrieben');
    assert.equal(row(id).caldav_account_id, accounts[owner].accountId);
    assert.equal(rowsWithUid().length, 1);
  });

  test(`dieselbe UID in zwei Konten: der Sofortversuch sendet nur über das besitzende Konto (${owner.toUpperCase()})`, async () => {
    const accounts = twoAccounts();
    const other = owner === 'a' ? 'b' : 'a';
    const id = mirror(accounts[owner], { title: 'Vorher' });
    edit(id, 'Bearbeitet');

    await caldavSync.flushOutbound();

    assertRequestsStayWithTheirAccount(accounts);
    assert.equal(summaryAt(accounts[owner]), 'Bearbeitet');
    assert.deepEqual(accounts[other].dav.requests.map(describe), [], 'der Sofortversuch hat das andere Konto angesprochen');
    assert.equal(row(id).outbound_dirty, 0);
  });

  test(`dieselbe UID in zwei Konten: eine Löschung geht nur über das besitzende Konto (${owner.toUpperCase()})`, async () => {
    const accounts = twoAccounts();
    const other = owner === 'a' ? 'b' : 'a';
    const id = mirror(accounts[owner]);
    assert.equal(outbound.queueEventDeletion(row(id)), true);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);

    await caldavSync.flushOutbound();

    assertRequestsStayWithTheirAccount(accounts);
    assert.equal(accounts[owner].dav.getObject(accounts[owner].url, 'shared.ics'), null, 'das Objekt des besitzenden Kontos steht noch');
    assert.ok(accounts[other].dav.getObject(accounts[other].url, 'shared.ics'), 'das Objekt des anderen Kontos wurde gelöscht');
    assert.deepEqual(accounts[other].dav.requests.map(describe), []);
    assert.equal(tombstoneCount(), 0);
  });
}

test('das besitzende Konto wird gelöscht: die Zeile bleibt ohne Konto, und das zweite übernimmt sie beim nächsten Abruf', async () => {
  const accounts = twoAccounts();
  await caldavSync.sync();
  const [before] = rowsWithUid();
  assert.equal(before.caldav_account_id, accounts.a.accountId);

  caldavSync.deleteAccount(accounts.a.accountId);

  assert.equal(row(before.id).caldav_account_id, null, 'die Zeile trägt ein gelöschtes Konto');
  assert.equal(row(before.id).title, 'Aus A', 'der Termin ging mit dem Konto verloren');

  await caldavSync.sync();

  const rows = rowsWithUid();
  assert.deepEqual(rows.map((r) => r.id), [before.id], 'das zweite Konto hat eine neue Zeile angelegt statt die bestehende zu übernehmen');
  assert.equal(rows[0].caldav_account_id, accounts.b.accountId);
  assert.equal(rows[0].title, 'Aus B');
  assert.equal(rows[0].external_object_url, accounts.b.objectUrl);
});

test('das besitzende Konto liefert die UID nicht mehr: seine Zeile geht, und das zweite legt den Termin an', async () => {
  const accounts = twoAccounts();
  await caldavSync.sync();
  const [before] = rowsWithUid();
  assert.equal(before.caldav_account_id, accounts.a.accountId);

  // Auf dem Server von A gelöscht (von einem anderen Client).
  accounts.a.dav.reset();
  accounts.a.dav.addCollection('family', { name: 'Familie' });
  accounts.a.dav.putObject(accounts.a.url, 'neighbour.ics', vevent('neighbour-user-a@test', 'Nachbar'));
  await caldavSync.sync();

  const rows = rowsWithUid();
  assert.equal(rows.length, 1, 'der Termin des zweiten Kontos fehlt oder steht doppelt');
  assert.notEqual(rows[0].id, before.id, 'die Zeile des ersten Kontos wurde nicht entfernt, sondern weitergereicht');
  assert.equal(rows[0].caldav_account_id, accounts.b.accountId);
  assert.equal(rows[0].title, 'Aus B');
  assertRequestsStayWithTheirAccount(accounts);
});

// ── 2: eine gespeicherte Adresse auf einem anderen Server ───────────────────────

test('gespeicherte Adresse auf einem fremden Server: der Sofortversuch schickt nichts dorthin', async () => {
  const accounts = twoAccounts();
  const foreignUrl = `${servers.foreign.origin}/cal/family/shared.ics`;
  const id = mirror(accounts.a, { objectUrl: foreignUrl, title: 'Vorher' });
  edit(id, 'Bearbeitet');
  tombstone(accounts.a, { uid: 'gone@test', objectUrl: `${servers.foreign.origin}/cal/family/gone.ics` });

  await caldavSync.flushOutbound();

  assert.deepEqual(servers.foreign.requests.map(describe), [], 'eine Anfrage ging an einen Server, der nicht der des Kontos ist');
  assert.equal(row(id).outbound_dirty, 1, 'die Bearbeitung gilt als gesendet');
  assert.equal(row(id).outbound_attempts, 0, 'ein nicht gesendeter Versuch wurde gezählt');
  assert.deepEqual(db.prepare('SELECT attempts FROM calendar_pending_deletions').all(), [{ attempts: 0 }],
    'der Löschauftrag ist fort oder hat einen Versuch gezählt');
});

test('gespeicherte Adresse auf einem fremden Server: der Lauf sendet an das Objekt, das der Server des Kontos nennt', async () => {
  const accounts = twoAccounts();
  const foreignUrl = `${servers.foreign.origin}/cal/family/shared.ics`;
  const id = mirror(accounts.a, { objectUrl: foreignUrl, title: 'Vorher' });
  edit(id, 'Bearbeitet');
  // Ein Löschauftrag, dessen Objekt der Server des Kontos unter eigener Adresse führt.
  accounts.a.dav.putObject(accounts.a.url, 'gone.ics', vevent('gone@test', 'Soll weg'));
  tombstone(accounts.a, { uid: 'gone@test', objectUrl: `${servers.foreign.origin}/cal/family/gone.ics` });

  await caldavSync.sync();

  assert.deepEqual(servers.foreign.requests.map(describe), [], 'eine Anfrage ging an einen Server, der nicht der des Kontos ist');
  assertRequestsStayWithTheirAccount(accounts);
  assert.equal(summaryAt(accounts.a), 'Bearbeitet', 'die Bearbeitung kam beim Server des Kontos nicht an');
  assert.equal(row(id).outbound_dirty, 0);
  assert.equal(row(id).external_object_url, accounts.a.objectUrl, 'die Zeile merkt sich weiter die fremde Adresse');
  assert.equal(accounts.a.dav.getObject(accounts.a.url, 'gone.ics'), null, 'die Löschung kam beim Server des Kontos nicht an');
  assert.equal(tombstoneCount(), 0);
});

/** Eine Antwort auf den Objektabruf, die gültig ist und nichts nennt. */
function answerEmptyOnce(acc) {
  acc.dav.refuse({
    method: 'REPORT', path: new URL(acc.url).pathname, status: 207, contentType: 'application/xml',
    body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>', once: true,
  });
}

test('der Abruf nennt das Objekt nicht (leere Antwort): die Löschung geht trotzdem hinaus, und der Termin kommt nicht zurück', async (t) => {
  const accounts = twoAccounts();
  accounts.a.dav.putObject(accounts.a.url, 'gone.ics', vevent('gone@test', 'Soll weg'));
  tombstone(accounts.a, { uid: 'gone@test', objectUrl: `${accounts.a.url}gone.ics` });
  answerEmptyOnce(accounts.a);

  const lines = await logged(t, () => caldavSync.sync());

  assert.equal(accounts.a.dav.getObject(accounts.a.url, 'gone.ics'), null, 'der Auftrag fiel, ohne dass gelöscht wurde');
  assert.equal(tombstoneCount(), 0);
  assert.equal(lines.filter((l) => /1 pending deletion\(s\) applied/.test(l.text)).length, 1);

  await caldavSync.sync();
  assert.deepEqual(rowsWithUid('gone@test'), [], 'der gelöschte Termin ist zurück');
  assertRequestsStayWithTheirAccount(accounts);
});

test('ein Auftrag, der ohne Anfrage fällt, wird nicht als Löschung gemeldet', async (t) => {
  const accounts = twoAccounts();
  // Ohne gespeicherte Adresse, und der Server führt das Objekt nicht (mehr).
  tombstone(accounts.a, { uid: 'never@test', objectUrl: null });

  const lines = await logged(t, () => caldavSync.sync());

  assert.equal(tombstoneCount(), 0);
  assert.deepEqual(writesAt(accounts.a.dav).map(describe), []);
  assert.deepEqual(lines.filter((l) => /pending deletion\(s\) applied/.test(l.text)), [],
    'gemeldet wurde eine Löschung, die es nicht gab');
});

test('der Abruf nennt das Objekt nicht (leere Antwort): eine wartende Bearbeitung bleibt vorgemerkt', async (t) => {
  const accounts = twoAccounts();
  const id = mirror(accounts.a, { title: 'Vorher' });
  edit(id, 'Bearbeitet');
  answerEmptyOnce(accounts.a);

  const lines = await logged(t, () => caldavSync.sync());
  assert.equal(lines.filter((l) => l.level === 'warn' && /No source object for event/.test(l.text)).length, 1,
    'der Lauf hat das Vertagen nicht gemeldet');

  assert.deepEqual(writesAt(accounts.a.dav).map(describe), [], 'ohne das Objekt des Servers wurde geschrieben');
  assert.equal(row(id)?.outbound_dirty, 1, 'die Bearbeitung ist verloren');
  assert.equal(row(id).outbound_attempts, 0);
  assert.equal(row(id).title, 'Bearbeitet');

  await caldavSync.sync();
  assert.equal(summaryAt(accounts.a), 'Bearbeitet', 'der nächste Lauf hat die Bearbeitung nicht nachgeholt');
  assert.equal(row(id).outbound_dirty, 0);
});

test('gespeicherte Adresse auf einem fremden Server, und das Konto führt den Termin nicht: der Lauf räumt den Auftrag mit Meldung ab', async (t) => {
  const accounts = twoAccounts();
  tombstone(accounts.a, { uid: 'elsewhere@test', objectUrl: `${servers.foreign.origin}/cal/family/elsewhere.ics` });

  const lines = await logged(t, () => caldavSync.sync());

  assert.deepEqual(servers.foreign.requests.map(describe), []);
  assert.equal(tombstoneCount(), 0, 'der Auftrag bleibt für immer liegen');
  assert.equal(lines.filter((l) => l.level === 'warn' && /not on the server of its account/.test(l.text)).length, 1);
  assert.deepEqual(lines.filter((l) => /pending deletion\(s\) applied/.test(l.text)), []);
});

// ── Kalenderumzug: Anlegen im Ziel ──────────────────────────────────────────────

/** Konto A mit einem zweiten eingeschalteten Kalender `work` als Umzugsziel. */
function accountWithTwoCalendars() {
  const accounts = twoAccounts();
  const workUrl = accounts.a.dav.addCollection('work', { name: 'Arbeit' });
  accounts.a.dav.putObject(workUrl, 'neighbour.ics', vevent('neighbour-work@test', 'Nachbar'));
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Arbeit', '#4A90E2', 1)
  `).run(accounts.a.accountId, workUrl);
  return { ...accounts, workUrl };
}

for (const run of ['sync', 'flushOutbound']) {
  test(`Kalenderumzug: der Termin wird im Ziel angelegt, in der Quelle gelöscht, und die Zeile zieht mit (${run})`, async () => {
    const { a, b, workUrl } = accountWithTwoCalendars();
    const id = mirror(a, { title: 'Zieht um' });
    db.prepare('UPDATE calendar_events SET outbound_move_to = ? WHERE id = ?').run(workUrl, id);

    await caldavSync[run]();

    assertRequestsStayWithTheirAccount({ a, b });
    assert.deepEqual(a.dav.objectNames(workUrl).sort(), ['neighbour.ics', 'shared.ics'], 'im Ziel liegt der Termin nicht');
    assert.equal(a.dav.getObject(a.url, 'shared.ics'), null, 'in der Quelle liegt der Termin noch');
    assert.equal(row(id).outbound_move_to, null);
    assert.equal(row(id).calendar_ref_id, calendarRef(workUrl));
    assert.equal(row(id).external_object_url, `${workUrl}shared.ics`);
    assert.equal(row(id).caldav_account_id, a.accountId);
    assert.deepEqual(writesAt(b.dav).map(describe), []);
  });

}

test('die Host-Sperre prüft bei jeder Methode die Adresse, an die gesendet wird', async () => {
  const { withAccountOrigin, isOriginRefusal } = await import('../server/utils/caldav-client.js');
  const bases = ['https://a.example/dav/', 'https://a.example/cal/family/', 'https://a.example/cal/work/'];
  const sent = [];
  const stub = {
    // genau wie tsdav 2.3.4: der Dateiname wird gegen die Collection aufgelöst.
    createCalendarObject: async ({ calendar, filename }) => { sent.push(new URL(String(filename), String(calendar.url)).href); return { ok: true }; },
    updateCalendarObject: async ({ calendarObject }) => { sent.push(calendarObject.url); return { ok: true }; },
    deleteCalendarObject: async ({ calendarObject }) => { sent.push(calendarObject.url); return { ok: true }; },
    fetchCalendarObjects: async ({ calendar }) => { sent.push(calendar.url); return []; },
  };
  const client = withAccountOrigin(stub, bases);
  const refused = async (label, run) => {
    sent.length = 0;
    await assert.rejects(run, (err) => isOriginRefusal(err), label);
    assert.deepEqual(sent, [], `${label}: es wurde doch gesendet`);
  };
  const allowed = async (label, run, expected) => {
    sent.length = 0;
    await run();
    assert.deepEqual(sent, [expected], label);
  };

  // createCalendarObject: ein Dateiname, der zu einer Adresse ausserhalb des
  // Servers aufloest, wird abgewiesen - der Name allein sagt noch nichts.
  await refused('create: Name loest off-host auf',
    () => client.createCalendarObject({ calendar: { url: 'https://a.example/cal/work/' }, filename: 'http:elsewhere.example.ics', iCalString: 'x' }));
  await allowed('create: gewoehnlicher Name im eigenen Kalender',
    () => client.createCalendarObject({ calendar: { url: 'https://a.example/cal/work/' }, filename: 'uid.ics', iCalString: 'x' }),
    'https://a.example/cal/work/uid.ics');
  await refused('create: Collection selbst off-host',
    () => client.createCalendarObject({ calendar: { url: 'https://b.example/cal/work/' }, filename: 'uid.ics', iCalString: 'x' }));

  await refused('update: Objektadresse off-host',
    () => client.updateCalendarObject({ calendarObject: { url: 'https://b.example/cal/x.ics', data: 'x' } }));
  await refused('delete: Objektadresse off-host',
    () => client.deleteCalendarObject({ calendarObject: { url: 'https://b.example/cal/x.ics' } }));
  await refused('fetch: Collection off-host',
    () => client.fetchCalendarObjects({ calendar: { url: 'https://b.example/cal/family/' } }));
  await allowed('update: eigene Objektadresse',
    () => client.updateCalendarObject({ calendarObject: { url: 'https://a.example/cal/family/x.ics', data: 'x' } }),
    'https://a.example/cal/family/x.ics');
});

// ── 3: ein Konto zieht auf einen anderen Server um ──────────────────────────────

/** Konto A mit zwei gespiegelten Terminen; `moved` führt dieselben Termine. */
async function movedAccount() {
  reset();
  const a = account(servers.a, 'user-a');
  a.dav.putObject(a.url, 'shared.ics', vevent(UID, 'Termin eins'));
  a.dav.putObject(a.url, 'second.ics', vevent('second@test', 'Termin zwei'));
  await caldavSync.sync();
  const ids = db.prepare("SELECT id FROM calendar_events WHERE external_source = 'caldav' ORDER BY id").all().map((r) => r.id);
  assert.equal(ids.length, 3);

  const movedUrl = servers.moved.addCollection('family', { name: 'Familie' });
  servers.moved.putObject(movedUrl, 'neighbour.ics', vevent('neighbour-user-a@test', 'Nachbar'));
  servers.moved.putObject(movedUrl, 'shared.ics', vevent(UID, 'Termin eins'));
  servers.moved.putObject(movedUrl, 'second.ics', vevent('second@test', 'Termin zwei'));
  return { a, ids, movedUrl };
}

async function moveAccount(a, movedUrl) {
  await caldavSync.updateAccount(a.accountId, { caldavUrl: servers.moved.url, password: 'p-new' });
  caldavSync.updateCalendarSelection(a.accountId, movedUrl, true);
  servers.a.requests.length = 0;
}

test('neue Serveradresse: nach Neuauswahl und Lauf sind es dieselben Zeilen, keine neue', async () => {
  const { a, ids, movedUrl } = await movedAccount();
  // Ein Löschauftrag von vorher zeigt auf den alten Server.
  tombstone(a, { uid: 'old@test', objectUrl: `${a.url}old.ics` });

  await moveAccount(a, movedUrl);
  assert.equal(tombstoneCount(), 0, 'ein Löschauftrag für den alten Server hat den Umzug überlebt');

  await caldavSync.sync();

  const rows = db.prepare("SELECT * FROM calendar_events WHERE external_source = 'caldav' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => r.id), ids, 'der Umzug hat Zeilen neu angelegt oder verloren');
  for (const r of rows) {
    assert.equal(r.caldav_account_id, a.accountId);
    assert.equal(r.calendar_ref_id, calendarRef(movedUrl), `Zeile ${r.id} hängt noch am alten Kalender`);
    assert.ok(r.external_object_url.startsWith(movedUrl), `Zeile ${r.id} merkt sich noch die alte Adresse`);
  }
  assert.deepEqual(servers.a.requests.map(describe), [], 'der alte Server wurde nach dem Umzug noch angesprochen');
});

test('neue Serveradresse: eine wartende Bearbeitung kommt am neuen Server an, der alte sieht nichts', async () => {
  const { a, ids, movedUrl } = await movedAccount();
  const id = rowsWithUid()[0].id;
  edit(id, 'Bearbeitet');

  await moveAccount(a, movedUrl);
  await caldavSync.flushOutbound();
  assert.deepEqual(servers.a.requests.map(describe), [], 'der Sofortversuch ging an den alten Server');

  await caldavSync.sync();

  assert.deepEqual(servers.a.requests.map(describe), [], 'der alte Server wurde im Lauf nach dem Umzug noch angesprochen');
  assert.match(servers.moved.getObject(movedUrl, 'shared.ics').data, /SUMMARY:Bearbeitet/, 'die Bearbeitung kam am neuen Server nicht an');
  assert.equal(row(id).outbound_dirty, 0);
  assert.equal(row(id).external_object_url, `${movedUrl}shared.ics`);
  assert.deepEqual(db.prepare("SELECT id FROM calendar_events WHERE external_source = 'caldav' ORDER BY id").all().map((r) => r.id), ids);
});

// ── 5: eine Zeile ohne Konto ────────────────────────────────────────────────────

test('Zeile ohne Konto: das erste Konto, das ihre UID liefert, übernimmt sie', async () => {
  const accounts = twoAccounts();
  // Nur Konto B liefert die UID.
  accounts.a.dav.reset();
  accounts.a.dav.addCollection('family', { name: 'Familie' });
  accounts.a.dav.putObject(accounts.a.url, 'neighbour.ics', vevent('neighbour-user-a@test', 'Nachbar'));
  const id = mirror(accounts.b, { owner: null, withCalendar: false, objectUrl: null, title: 'Alt' });

  await caldavSync.sync();

  const rows = rowsWithUid();
  assert.deepEqual(rows.map((r) => r.id), [id], 'die Zeile wurde verdoppelt statt übernommen');
  assert.equal(rows[0].caldav_account_id, accounts.b.accountId);
  assert.equal(rows[0].title, 'Aus B');
  assert.equal(rows[0].external_object_url, accounts.b.objectUrl);
});

test('Zeile ohne Konto, für ein anderes Konto bestimmt: nur dieses übernimmt sie', async () => {
  const accounts = twoAccounts();
  const id = mirror(accounts.b, {
    owner: null, withCalendar: false, objectUrl: null, title: 'Alt',
    fields: { target_caldav_account_id: accounts.b.accountId, target_caldav_calendar_url: accounts.b.url },
  });

  await caldavSync.sync();

  let rows = rowsWithUid();
  assert.deepEqual(rows.map((r) => r.id), [id]);
  assert.equal(rows[0].caldav_account_id, accounts.b.accountId, 'das Konto, für das die Zeile nicht bestimmt war, hat sie übernommen');
  assert.equal(rows[0].title, 'Aus B');

  // Liefert nur das andere Konto die UID, bleibt die Zeile, wie sie ist - und allein.
  const second = twoAccounts();
  second.b.dav.reset();
  second.b.dav.addCollection('family', { name: 'Familie' });
  second.b.dav.putObject(second.b.url, 'neighbour.ics', vevent('neighbour-user-b@test', 'Nachbar'));
  const kept = mirror(second.b, {
    owner: null, withCalendar: false, objectUrl: null, title: 'Alt',
    fields: { target_caldav_account_id: second.b.accountId, target_caldav_calendar_url: second.b.url },
  });
  await caldavSync.sync();
  rows = rowsWithUid();
  assert.deepEqual(rows.map((r) => r.id), [kept], 'neben der Zeile ohne Konto entstand eine zweite');
  assert.equal(rows[0].caldav_account_id, null);
  assert.equal(rows[0].title, 'Alt');
});

test('Zeile ohne Konto, deren Ziel ein Konto nennt, das es nicht mehr gibt: sie wird übernommen', async () => {
  const accounts = twoAccounts();
  accounts.a.dav.reset();
  accounts.a.dav.addCollection('family', { name: 'Familie' });
  accounts.a.dav.putObject(accounts.a.url, 'neighbour.ics', vevent('neighbour-user-a@test', 'Nachbar'));
  // Einst über ein inzwischen gelöschtes Konto hochgeladen: das Ziel blieb stehen.
  const id = mirror(accounts.b, {
    owner: null, withCalendar: false, title: 'Alt',
    fields: { target_caldav_account_id: 9999, target_caldav_calendar_url: accounts.b.url },
  });

  await caldavSync.sync();

  const rows = rowsWithUid();
  assert.deepEqual(rows.map((r) => r.id), [id]);
  assert.equal(rows[0].caldav_account_id, accounts.b.accountId, 'ein Ziel ohne Konto hält die Zeile von jeder Übernahme fern');
  assert.equal(rows[0].title, 'Aus B');
});

test('Zeile ohne Konto mit wartender Bearbeitung: nicht gesendet, nicht verdoppelt, je Lauf einmal gemeldet und am Ende aufgegeben', async (t) => {
  const accounts = twoAccounts();
  const id = mirror(accounts.a, { owner: null, title: 'Alt' });
  edit(id, 'Lokal bearbeitet');

  for (let run = 1; run < outbound.MAX_OUTBOUND_ATTEMPTS; run++) {
    const lines = await logged(t, () => caldavSync.sync());
    assert.deepEqual([...writesAt(accounts.a.dav), ...writesAt(accounts.b.dav)].map(describe), [],
      `Lauf ${run}: die Bearbeitung einer Zeile ohne Konto wurde gesendet`);
    const rows = rowsWithUid();
    assert.deepEqual(rows.map((r) => r.id), [id], `Lauf ${run}: die Zeile wurde verdoppelt`);
    assert.equal(rows[0].caldav_account_id, null, `Lauf ${run}: eine Zeile mit wartender Bearbeitung wurde übernommen`);
    assert.equal(rows[0].title, 'Lokal bearbeitet');
    assert.equal(rows[0].outbound_dirty, 1);
    assert.equal(rows[0].outbound_attempts, run, `Lauf ${run}: der Versuch wurde nicht gezählt`);
    assert.equal(lines.filter((l) => l.level === 'warn' && /no CalDAV account/.test(l.text)).length, 1,
      `Lauf ${run}: die wartende Bearbeitung wurde nicht genau einmal gemeldet`);
  }

  // Der letzte Versuch: aufgegeben, danach ist die Zeile sauber und übernehmbar.
  await caldavSync.sync();
  assert.deepEqual([...writesAt(accounts.a.dav), ...writesAt(accounts.b.dav)].map(describe), []);
  const rows = rowsWithUid();
  assert.deepEqual(rows.map((r) => r.id), [id]);
  assert.equal(rows[0].outbound_dirty, 0, 'die Bearbeitung wartet weiter, statt aufgegeben zu werden');
  assert.equal(rows[0].caldav_account_id, accounts.a.accountId, 'die aufgegebene Zeile wurde nicht übernommen');
  assert.equal(rows[0].title, 'Aus A');
});

test('Zeile ohne Konto: Bearbeiten merkt nichts vor, Löschen legt keinen Löschauftrag an', () => {
  const accounts = twoAccounts();
  const id = mirror(accounts.a, { owner: null, title: 'Alt' });
  const before = row(id);
  db.prepare("UPDATE calendar_events SET title = 'Neu' WHERE id = ?").run(id);

  assert.equal(outbound.markEventOutbound(before, row(id)), false, 'eine Zeile ohne Konto meldet ausgehende Arbeit');
  assert.equal(row(id).outbound_dirty, 0);

  assert.equal(outbound.queueEventDeletion(row(id)), false);
  assert.equal(tombstoneCount(), 0, 'für eine Zeile ohne Konto entstand ein Löschauftrag');

  // Gegenprobe: mit Konto geschieht beides.
  const owned = mirror(accounts.b, { uid: 'owned@test', title: 'Alt' });
  const ownedBefore = row(owned);
  db.prepare("UPDATE calendar_events SET title = 'Neu' WHERE id = ?").run(owned);
  assert.equal(outbound.markEventOutbound(ownedBefore, row(owned)), true);
  assert.equal(outbound.queueEventDeletion(row(owned)), true);
  assert.deepEqual(db.prepare('SELECT caldav_account_id FROM calendar_pending_deletions').all(),
    [{ caldav_account_id: accounts.b.accountId }]);
});

// ── 6: ein Löschauftrag ohne Kalender ───────────────────────────────────────────

for (const run of ['sync', 'flushOutbound']) {
  test(`Löschauftrag ohne Kalender: er läuft im Konto, zu dem er gehört (${run})`, async () => {
    const accounts = twoAccounts();
    tombstone(accounts.b, { calendarUrl: '' });

    await caldavSync[run]();

    assertRequestsStayWithTheirAccount(accounts);
    assert.deepEqual(writesAt(accounts.a.dav).map(describe), [], 'ein anderes Konto hat die Löschung ausgeführt');
    assert.equal(accounts.b.dav.getObject(accounts.b.url, 'shared.ics'), null, 'die Löschung kam im eigenen Konto nicht an');
    assert.ok(accounts.a.dav.getObject(accounts.a.url, 'shared.ics'), 'das Objekt des anderen Kontos wurde gelöscht');
    assert.equal(tombstoneCount(), 0);
  });
}

test('Löschauftrag ohne Konto: der Lauf räumt ihn ab und meldet es, gesendet wird nichts', async (t) => {
  const accounts = twoAccounts();
  tombstone(accounts.b, { owner: null, calendarUrl: '', uid: 'gone@test', objectUrl: `${accounts.b.url}gone.ics` });
  tombstone(accounts.a, { owner: null, uid: 'gone-2@test', objectUrl: `${accounts.a.url}gone-2.ics` });
  accounts.b.dav.putObject(accounts.b.url, 'gone.ics', vevent('gone@test', 'Bleibt'));

  await caldavSync.flushOutbound();
  assert.equal(tombstoneCount(), 2, 'der Sofortversuch hat einen Löschauftrag ohne Konto angefasst');
  assert.deepEqual([...writesAt(accounts.a.dav), ...writesAt(accounts.b.dav)].map(describe), []);

  const lines = await logged(t, () => caldavSync.sync());

  assert.equal(tombstoneCount(), 0, 'ein Löschauftrag ohne Konto bleibt liegen');
  assert.deepEqual([...writesAt(accounts.a.dav), ...writesAt(accounts.b.dav)].map(describe), [],
    'ein Löschauftrag ohne Konto wurde gesendet');
  assert.equal(lines.filter((l) => l.level === 'warn' && /2 pending deletion/.test(l.text)).length, 1,
    'das Abräumen wurde nicht gemeldet');
});

// ── 7: das Upload-Ziel ──────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = userId; req.authRole = 'admin'; next(); });
app.use('/calendar', calendarRouter);
const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => new Promise((resolve) => { http.closeAllConnections?.(); http.close(resolve); }));
const api = (method, path, body) => fetch(`http://127.0.0.1:${http.address().port}/calendar${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const newEvent = (target) => ({
  title: 'Neu', start_datetime: '2035-03-10T10:00', end_datetime: '2035-03-10T11:00', ...target,
});

/** Zwei Konten; A führt zusätzlich einen abgewählten Kalender. */
function accountsWithDisabledCalendar() {
  const accounts = twoAccounts();
  const disabledUrl = accounts.a.dav.addCollection('work', { name: 'Arbeit' });
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Arbeit', '#4A90E2', 0)
  `).run(accounts.a.accountId, disabledUrl);
  return { ...accounts, disabledUrl };
}

test('Upload-Ziel: angenommen wird nur ein Paar aus Konto und eingeschaltetem Kalender - genau die angebotenen', async () => {
  const { a, b, disabledUrl } = accountsWithDisabledCalendar();

  const offered = (await (await api('GET', '/sync-targets')).json()).data.caldav
    .map((target) => [target.accountId, target.calendarUrl]);
  assert.deepEqual(offered.sort(), [[a.accountId, a.url], [b.accountId, b.url]].sort());
  for (const [accountId, calendarUrl] of offered) {
    const res = await api('POST', '', newEvent({ target_caldav_account_id: accountId, target_caldav_calendar_url: calendarUrl }));
    assert.equal(res.status, 201, `ein angebotenes Ziel wurde abgelehnt: ${accountId} ${calendarUrl}`);
  }

  const refused = {
    'der abgewählte Kalender des Kontos': [a.accountId, disabledUrl],
    'der Kalender eines anderen Kontos': [a.accountId, b.url],
    'ein Kalender, den niemand führt': [a.accountId, `${servers.foreign.origin}/cal/family/`],
    'ein Konto, das es nicht gibt': [9999, a.url],
  };
  for (const [what, [accountId, calendarUrl]] of Object.entries(refused)) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
    const res = await api('POST', '', newEvent({ target_caldav_account_id: accountId, target_caldav_calendar_url: calendarUrl }));
    assert.equal(res.status, 400, `${what} wurde als Ziel angenommen`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, count, `${what}: der Termin wurde trotzdem angelegt`);
  }
});

test('Upload-Ziel beim Bearbeiten: ein neues Ziel wird geprüft, ein unverändertes Altziel blockiert das Speichern nicht', async () => {
  const { a, b, disabledUrl } = accountsWithDisabledCalendar();
  const insert = (fields) => {
    const id = Number(db.prepare(`
      INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by)
      VALUES ('Lokal', '2035-03-10T10:00', '2035-03-10T11:00', 0, ?)
    `).run(userId).lastInsertRowid);
    for (const [column, value] of Object.entries(fields)) {
      db.prepare(`UPDATE calendar_events SET ${column} = ? WHERE id = ?`).run(value, id);
    }
    return id;
  };

  // Neues Ziel außerhalb der Auswahl: abgelehnt, nichts geschrieben.
  const local = insert({});
  let res = await api('PUT', `/${local}`, { title: 'Umbenannt', target_caldav_account_id: a.accountId, target_caldav_calendar_url: disabledUrl });
  assert.equal(res.status, 400);
  assert.equal(row(local).title, 'Lokal');
  assert.equal(row(local).target_caldav_account_id, null);

  // Neues Ziel aus der Auswahl: angenommen.
  res = await api('PUT', `/${local}`, { target_caldav_account_id: b.accountId, target_caldav_calendar_url: b.url });
  assert.equal(res.status, 200);
  assert.equal(row(local).target_caldav_calendar_url, b.url);

  // Ein gespeichertes Altziel, das das Formular unverändert zurückschickt.
  const stale = insert({ target_caldav_account_id: a.accountId, target_caldav_calendar_url: disabledUrl });
  res = await api('PUT', `/${stale}`, { title: 'Umbenannt', target_caldav_account_id: a.accountId, target_caldav_calendar_url: disabledUrl });
  assert.equal(res.status, 200, 'ein unverändertes Altziel verhindert jede Bearbeitung des Termins');
  assert.equal(row(stale).title, 'Umbenannt');
  // Zurück auf "lokal" geht immer.
  res = await api('PUT', `/${stale}`, { target_caldav_account_id: null, target_caldav_calendar_url: null });
  assert.equal(res.status, 200);
  assert.equal(row(stale).target_caldav_account_id, null);

  // Ein gespiegelter Termin wechselt den Kalender nur innerhalb seines Kontos.
  const mirrored = mirror(a, { title: 'Gespiegelt' });
  res = await api('PUT', `/${mirrored}`, { target_caldav_account_id: b.accountId, target_caldav_calendar_url: b.url });
  assert.equal(res.status, 400, 'ein gespiegelter Termin bekam den Kalender eines anderen Kontos als Ziel');
  assert.equal(row(mirrored).target_caldav_account_id, null);
  assert.equal(row(mirrored).outbound_move_to, null);
  res = await api('PUT', `/${mirrored}`, { target_caldav_account_id: a.accountId, target_caldav_calendar_url: a.url });
  assert.equal(res.status, 200);
});

test('Upload-Ziel: ein gespeichertes Altziel außerhalb der Auswahl wird nicht hochgeladen', async () => {
  const { a, b, disabledUrl } = accountsWithDisabledCalendar();
  const insert = (accountId, calendarUrl) => Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, target_caldav_account_id, target_caldav_calendar_url)
    VALUES ('Wartet', '2035-03-10T10:00', '2035-03-10T11:00', 0, ?, ?, ?)
  `).run(userId, accountId, calendarUrl).lastInsertRowid);
  const stale = insert(a.accountId, disabledUrl);
  const good = insert(a.accountId, a.url);

  await caldavSync.sync();

  assert.deepEqual(a.dav.objectNames(disabledUrl), [], 'in einen abgewählten Kalender wurde hochgeladen');
  assert.equal(row(stale).external_source, 'local');
  assert.equal(row(stale).caldav_account_id, null);
  // Gegenprobe: ein Ziel aus der Auswahl geht hinaus, und die Zeile gehört danach dem Konto.
  assert.equal(row(good).external_source, 'caldav');
  assert.equal(row(good).caldav_account_id, a.accountId, 'der hochgeladene Termin gehört keinem Konto');
  assertRequestsStayWithTheirAccount({ a, b });
});

// ── 8: ein Server, zwei Benutzer, derselbe Kalender ─────────────────────────────

for (const run of ['sync', 'flushOutbound']) {
  test(`ein Server, zwei Benutzer, derselbe Kalender: gesendet wird über das Konto der Zeile (${run})`, async () => {
    const accounts = twoUsersOneCalendar();
    accounts.a.dav.putObject(accounts.a.url, 'gone.ics', vevent('gone@test', 'Soll weg'));
    // Beides gehört dem ZWEITEN Konto; das erste führt denselben Kalender.
    const id = mirror(accounts.b, { title: 'Geteilt' });
    edit(id, 'Bearbeitet');
    tombstone(accounts.b, { uid: 'gone@test', objectUrl: `${accounts.b.url}gone.ics` });

    await caldavSync[run]();

    const writes = writesAt(accounts.a.dav);
    assert.deepEqual(writes.map((r) => r.method).sort(), ['DELETE', 'PUT']);
    assert.deepEqual(writes.filter((r) => senderOf(r).user !== 'user-b').map(describe), [],
      'eine Anfrage kam nicht über das Konto, dem die Zeile gehört');
    assert.equal(summaryAt(accounts.a), 'Bearbeitet');
    assert.equal(row(id).outbound_dirty, 0);
    assert.equal(row(id).caldav_account_id, accounts.b.accountId);
    assert.equal(tombstoneCount(), 0);
  });
}

// ── Der geteilte Inline-Marker (#1860, housekeeping.js + birthdays.js) ────────────

test('markInlineOutbound merkt nur vormerkbare Zeilen vor und lässt einen CalDAV-Termin ohne Konto in Ruhe', () => {
  const accounts = twoAccounts();
  const owned = row(mirror(accounts.a, { uid: 'm-owned@test', title: 'Konto' }));
  const orphan = row(mirror(accounts.a, { owner: null, uid: 'm-orphan@test', title: 'Ohne Konto' }));
  const local = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(
    Number(db.prepare("INSERT INTO calendar_events (title, start_datetime, created_by, external_source) VALUES ('Lokal','2035-01-01T09:00',?, 'local')").run(userId).lastInsertRowid)
  );

  assert.equal(outbound.markInlineOutbound(db, owned), true);
  assert.equal(row(owned.id).outbound_dirty, 1);
  assert.equal(outbound.markInlineOutbound(db, orphan), false, 'eine Zeile ohne Konto wurde vorgemerkt');
  assert.equal(row(orphan.id).outbound_dirty, 0);
  assert.equal(outbound.markInlineOutbound(db, local), false, 'eine lokale Zeile wurde vorgemerkt');
});

test('retitleBirthdayEvents merkt einen gespiegelten Geburtstag mit Konto vor, einen ohne Konto nicht', () => {
  const accounts = twoAccounts();
  db.prepare('DELETE FROM sync_config').run();
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('language', 'de')").run();
  const birthday = (name, owner) => {
    const eventId = mirror(accounts.a, { owner, uid: `bday-${name}@test`, title: 'Alt', withCalendar: true });
    // englischer Bestandstitel, den der Lauf auf Deutsch zieht
    db.prepare("UPDATE calendar_events SET title = 'Old', description = 'x', outbound_dirty = 0 WHERE id = ?").run(eventId);
    db.prepare('INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by) VALUES (?, ?, ?, ?)')
      .run(name, '2014-05-10', eventId, userId);
    return eventId;
  };
  const withAccount = birthday('Mit', accounts.a.accountId);
  const withoutAccount = birthday('Ohne', null);

  const changed = retitleBirthdayEvents(db);
  assert.ok(changed >= 2, 'die Titel wurden nicht neu geschrieben');

  assert.equal(row(withAccount).outbound_dirty, 1, 'der gespiegelte Geburtstag mit Konto wurde nicht vorgemerkt');
  assert.equal(row(withoutAccount).outbound_dirty, 0, 'ein Geburtstag ohne Konto wurde vorgemerkt und bliebe unübernommen');
});

test('ein zweiter Löschauftrag für dieselbe UID im selben Kalender lässt Konto und Adresse des ersten unangetastet', () => {
  const accounts = twoAccounts();
  // Erster Auftrag: Konto A mit seiner Adresse.
  assert.equal(outbound.queueDeletion({
    source: 'caldav', calendarExternalId: accounts.a.url, eventExternalId: UID,
    objectUrl: `${accounts.a.url}shared.ics`, accountId: accounts.a.accountId,
  }), true);
  // Zweiter Auftrag, gleicher Kalender, gleiche UID, aber Konto B und eine
  // andere Adresse: er darf die Adresse des ersten nicht mit Konto B paaren.
  outbound.queueDeletion({
    source: 'caldav', calendarExternalId: accounts.a.url, eventExternalId: UID,
    objectUrl: `${accounts.b.url}elsewhere.ics`, accountId: accounts.b.accountId,
  });

  const [t] = db.prepare('SELECT caldav_account_id, object_url FROM calendar_pending_deletions').all();
  assert.equal(tombstoneCount(), 1);
  assert.equal(t.caldav_account_id, accounts.a.accountId, 'das Konto des ersten Auftrags wurde überschrieben');
  assert.equal(t.object_url, `${accounts.a.url}shared.ics`, 'die Adresse des ersten Auftrags wurde überschrieben');

  // Ein Auftrag OHNE Adresse füllt die fehlende Adresse eines Auftrags ohne sie.
  db.prepare('DELETE FROM calendar_pending_deletions').run();
  outbound.queueDeletion({ source: 'caldav', calendarExternalId: accounts.a.url, eventExternalId: UID, accountId: accounts.a.accountId });
  outbound.queueDeletion({
    source: 'caldav', calendarExternalId: accounts.a.url, eventExternalId: UID,
    objectUrl: `${accounts.a.url}shared.ics`, accountId: accounts.a.accountId,
  });
  const [t2] = db.prepare('SELECT caldav_account_id, object_url FROM calendar_pending_deletions').all();
  assert.equal(t2.object_url, `${accounts.a.url}shared.ics`, 'eine fehlende Adresse wurde nicht nachgetragen');
});

// ── #1861 und #1862 mit zwei Konten ─────────────────────────────────────────────

test('Umzug, die Quelle lehnt das Löschen ab: der Auftrag gehört dem Konto der Zeile, und nur dieses räumt die Quelle ab', async () => {
  const { a, b, workUrl } = accountWithTwoCalendars();
  const id = mirror(a, { title: 'Zieht um' });
  db.prepare('UPDATE calendar_events SET outbound_move_to = ? WHERE id = ?').run(workUrl, id);
  a.dav.refuse({ method: 'DELETE', status: 403, when: (req) => req.path.startsWith('/cal/family/') });

  await caldavSync.sync();

  assert.ok(a.dav.getObject(workUrl, 'shared.ics'), 'die Kopie im Ziel fehlt - der Fall ist nicht nachgestellt');
  assert.ok(a.dav.getObject(a.url, 'shared.ics'));
  assert.deepEqual(
    db.prepare('SELECT calendar_external_id, object_url, caldav_account_id, attempts FROM calendar_pending_deletions').all(),
    [{ calendar_external_id: a.url, object_url: a.objectUrl, caldav_account_id: a.accountId, attempts: 1 }],
    'das abgelehnte Löschen ist nicht für das Konto der Zeile vorgemerkt',
  );
  assert.equal(row(id).calendar_ref_id, calendarRef(workUrl));

  // Die Quelle lehnt weiter ab: die Zeile bleibt am Ziel und allein.
  await caldavSync.sync();
  assert.deepEqual(rowsWithUid().map((r) => r.id), [id]);
  assert.equal(row(id).calendar_ref_id, calendarRef(workUrl), 'die Zeile ist zur Quelle zurückgewandert');
  assert.equal(row(id).caldav_account_id, a.accountId);

  a.dav.allowAll();
  await caldavSync.sync();

  assert.equal(a.dav.getObject(a.url, 'shared.ics'), null, 'der Termin liegt weiter in beiden Kalendern');
  assert.ok(a.dav.getObject(workUrl, 'shared.ics'), 'die Kopie im Ziel wurde mit abgeräumt');
  assert.equal(tombstoneCount(), 0);
  assertRequestsStayWithTheirAccount({ a, b });
  assert.deepEqual(writesAt(b.dav).map(describe), [], 'das andere Konto hat geschrieben');
  assert.equal(summaryAt(b), 'Aus B', 'das Objekt des anderen Kontos wurde angefasst');
});

/** Führt `action` aus, sobald der erste PUT bei diesem Server ankommt. */
function duringPut(dav, action) {
  let ran = false;
  dav.refuse({ method: 'PUT', status: 500, when: () => { if (!ran) { ran = true; action(); } return false; } });
  return () => ran;
}

function waitingUpload(acc, title) {
  return Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, target_caldav_account_id, target_caldav_calendar_url)
    VALUES (?, '2035-03-10T10:00', '2035-03-10T11:00', 0, ?, ?, ?)
  `).run(title, userId, acc.accountId, acc.url).lastInsertRowid);
}

test('gelöscht, während der Upload läuft: der Auftrag gehört dem Konto des Uploads, und der Termin kommt nicht zurück', async () => {
  const accounts = twoAccounts();
  const id = waitingUpload(accounts.b, 'Wird gelöscht');
  const happened = duringPut(accounts.b.dav, () => db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id));

  await caldavSync.sync();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  accounts.b.dav.allowAll();
  const uploaded = accounts.b.dav.objectNames(accounts.b.url).filter((n) => n.startsWith('yuvomi-event-'));
  assert.equal(uploaded.length, 1, 'der Upload kam nicht an - der Fall ist nicht nachgestellt');
  assert.deepEqual(db.prepare('SELECT caldav_account_id, object_url FROM calendar_pending_deletions').all(),
    [{ caldav_account_id: accounts.b.accountId, object_url: `${accounts.b.url}${uploaded[0]}` }],
    'für das gerade angelegte Objekt steht kein Auftrag des hochladenden Kontos');

  await caldavSync.sync();
  await caldavSync.sync();

  assert.deepEqual(accounts.b.dav.objectNames(accounts.b.url).filter((n) => n.startsWith('yuvomi-event-')), [],
    'das Objekt des gelöschten Termins liegt weiter auf dem Server');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE title = 'Wird gelöscht'").get().n, 0, 'der gelöschte Termin ist zurück');
  assert.equal(tombstoneCount(), 0);
  assertRequestsStayWithTheirAccount(accounts);
});

test('bearbeitet, während der Upload läuft: die Zeile gehört dem Konto des Uploads, und die Bearbeitung geht über dieses hinaus', async () => {
  const accounts = twoAccounts();
  const id = waitingUpload(accounts.b, 'Alt');
  const happened = duringPut(accounts.b.dav, () => db.prepare("UPDATE calendar_events SET title = 'Neu' WHERE id = ?").run(id));

  await caldavSync.sync();
  assert.ok(happened());
  accounts.b.dav.allowAll();
  assert.equal(row(id).external_source, 'caldav');
  assert.equal(row(id).caldav_account_id, accounts.b.accountId);
  assert.equal(row(id).outbound_dirty, 1, 'die Zeile gilt als sauberer Spiegel, obwohl oben der alte Stand liegt');

  await caldavSync.sync();

  assert.equal(row(id).title, 'Neu', 'der Abruf hat die Bearbeitung mit dem alten Stand überschrieben');
  assert.equal(row(id).outbound_dirty, 0);
  const name = accounts.b.dav.objectNames(accounts.b.url).find((n) => n.startsWith('yuvomi-event-'));
  assert.match(accounts.b.dav.getObject(accounts.b.url, name).data, /SUMMARY:Neu/);
  assertRequestsStayWithTheirAccount(accounts);
  assert.deepEqual(writesAt(accounts.a.dav).map(describe), []);
});

test('Umzug abgelehnt, und für das Objekt steht schon der Auftrag eines ANDEREN Kontos: der bleibt unverändert, und der Umzug bleibt vorgemerkt', async (t) => {
  const accounts = twoUsersOneCalendar();
  const workUrl = accounts.a.dav.addCollection('work', { name: 'Arbeit' });
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Arbeit', '#4A90E2', 1)
  `).run(accounts.a.accountId, workUrl);
  // Der Auftrag von Konto B für dasselbe Objekt (ohne Adresse: der
  // Sofortversuch fasst ihn dann nicht an), schon dreimal abgelehnt.
  const theirs = tombstone(accounts.b, { objectUrl: null });
  db.prepare("UPDATE calendar_pending_deletions SET attempts = 3, last_error = 'von B' WHERE id = ?").run(theirs);
  const id = mirror(accounts.a, { title: 'Zieht um' });
  db.prepare('UPDATE calendar_events SET outbound_move_to = ? WHERE id = ?').run(workUrl, id);
  accounts.a.dav.refuse({ method: 'DELETE', status: 403, when: (req) => req.path.startsWith('/cal/family/') });

  const lines = await logged(t, () => caldavSync.flushOutbound());

  assert.ok(accounts.a.dav.seen('DELETE').length >= 1, 'der Fall ist nicht nachgestellt: das DELETE der Quelle lief nicht');
  assert.deepEqual(
    db.prepare('SELECT id, caldav_account_id, attempts, last_error, object_url FROM calendar_pending_deletions').all(),
    [{ id: theirs, caldav_account_id: accounts.b.accountId, attempts: 3, last_error: 'von B', object_url: null }],
    'die Absage von Konto A hat den Auftrag von Konto B verändert',
  );
  // Kein stilles "erledigt": der Umzug wartet weiter und hat einen Versuch gezählt.
  assert.equal(row(id).outbound_move_to, workUrl, 'der Umzug gilt als vollzogen, obwohl die Quelle noch steht und niemand sie für dieses Konto abräumt');
  assert.equal(row(id).outbound_attempts, 1);
  assert.equal(row(id).calendar_ref_id, calendarRef(accounts.a.url));
  assert.equal(lines.filter((l) => l.level === 'warn' && /another account/.test(l.text)).length, 1, 'der Fall wurde nicht gemeldet');
  assert.deepEqual(accounts.a.dav.seen('DELETE').map(describe), ['DELETE /cal/family/shared.ics (user-a)'], 'der Auftrag des anderen Kontos wurde angestossen');
});
