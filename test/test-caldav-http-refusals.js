/**
 * Test: eine Absage des CalDAV-Servers ist kein Erfolg.
 *
 * Der Fehler: tsdav (gemessen an 2.3.4) wirft bei einer HTTP-Absage nicht auf
 * allen Wegen. `createCalendarObject`, `updateCalendarObject` und
 * `deleteCalendarObject` lösen mit `ok: false` auf, `fetchCalendars` und
 * `fetchAddressBooks` mit `[]`. Kein Aufrufer las das, also galt
 *
 *   - ein abgelehnter PUT als hochgeladen: die Zeile wurde zum Spiegel eines
 *     Objekts, das es nicht gibt, und der nächste Abruf löschte sie als "auf
 *     dem Server entfernt";
 *   - eine abgelehnte Änderung als übertragen: der nächste Abruf überschrieb
 *     die lokale Bearbeitung mit dem alten Serverstand;
 *   - ein abgelehnter DELETE als gelöscht: der Tombstone fiel, der nächste
 *     Abruf holte den Eintrag zurück;
 *   - ein Umzug mit abgelehnter Kopie als vollzogen: die Quelle wurde
 *     gelöscht, der Termin war auf dem Server ganz weg;
 *   - eine abgelehnte Auflistung als "es gibt keine": der Lauf schaltete jede
 *     ausgewählte Liste ab.
 *
 * Warum ein Server und keine Attrappe: die Attrappen der übrigen CalDAV-Suiten
 * ersetzen den Client über die `createClient`-Factory. Sie gelingen oder sie
 * werfen - genau die zwei Antworten, die das echte tsdav bei einer Absage nicht
 * gibt -, und sie gehen an `createCalDAVClient` vorbei, wo die Regel sitzt.
 * Hier läuft deshalb jeder Fall ohne Factory: echte Dienste, echter Client,
 * echtes HTTP gegen `test/caldav-fake-server.js` auf 127.0.0.1.
 *
 * Jeder Fall prüft zuerst, dass die Absage wirklich am Server ankam (sonst
 * wäre "nichts gestempelt" auch ohne Versuch wahr), dann den Zustand danach,
 * dann den Folgelauf, in dem der Schaden entstand, und zuletzt, dass der Weg
 * nach der Absage wieder frei ist.
 *
 * Ausführen: node --experimental-sqlite --test test/test-caldav-http-refusals.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const {
  createCalDAVClient, createCardDAVClient, withHttpRefusalsAsErrors, DavHttpError,
} = await import('../server/utils/caldav-client.js');
const { classifyOutboundError, outboundFailureAction, MAX_OUTBOUND_ATTEMPTS } =
  await import('../server/services/calendar-outbound.js');
const todoOutbound   = await import('../server/services/caldav-todo-outbound.js');
const remindersSync  = await import('../server/services/caldav-reminders-sync.js');
const caldavSync     = await import('../server/services/caldav-sync.js');
const appleCalendar  = await import('../server/services/apple-calendar.js');
const cardavSync     = await import('../server/services/cardav-sync.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const dav = await startFakeDavServer();
test.after(() => dav.close());

// ── Fixtures ────────────────────────────────────────────────────────────────────

let accountId;

function reset() {
  for (const table of [
    'calendar_pending_deletions', 'calendar_events', 'external_calendars',
    'caldav_calendar_selection', 'caldav_todo_pending_deletions', 'tasks',
    'shopping_items', 'shopping_lists', 'caldav_reminder_selection', 'caldav_accounts',
    'carddav_addressbook_selection', 'carddav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  appleCalendar.clearCredentials();
  dav.reset();
  accountId = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Fake', ?, 'u', 'p')
  `).run(dav.url).lastInsertRowid);
}

function vtodo(uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20260701T080000Z', `SUMMARY:${summary}`,
    'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

function vevent(uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T090000Z', `SUMMARY:${summary}`,
    'DTSTART:20350310T090000Z', 'DTEND:20350310T100000Z', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * Eine für Aufgaben freigegebene Liste mit EINEM fremden Eintrag darin. Der
 * Nachbar ist nicht Dekoration: der Prune lässt eine Liste in Ruhe, die gar
 * nichts liefert (Leer-Guard), und ohne ihn sähe der Folgelauf harmlos aus.
 */
function taskList() {
  const url = dav.addCollection('todo', { name: 'Erinnerungen', components: ['VTODO'] });
  dav.putObject(url, 'neighbour.ics', vtodo('neighbour@test', 'Nachbar'));
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'Erinnerungen', 'tasks', 1)
  `).run(accountId, url);
  return url;
}

function shoppingList() {
  const url = dav.addCollection('shop', { name: 'Einkauf', components: ['VTODO'] });
  dav.putObject(url, 'neighbour.ics', vtodo('shop-neighbour@test', 'Nachbar'));
  const listId = db.prepare(
    "INSERT INTO shopping_lists (name, created_by) VALUES ('Einkauf', 1) RETURNING id"
  ).get().id;
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'Einkauf', 'shopping', 1, ?)
  `).run(accountId, url, listId);
  return { url, listId };
}

function localTask(listUrl, title = 'Hier angelegt') {
  const id = Number(db.prepare(`
    INSERT INTO tasks (title, created_by, target_caldav_account_id, target_caldav_list_url)
    VALUES (?, 1, ?, ?)
  `).run(title, accountId, listUrl).lastInsertRowid);
  return id;
}

/** Aufgabe, die schon Spiegel eines Serverobjekts ist. */
function mirroredTask(listUrl, uid, title) {
  const { url } = dav.putObject(listUrl, `${uid}.ics`, vtodo(uid, title));
  const id = Number(db.prepare(`
    INSERT INTO tasks (title, created_by, external_uid, external_source, external_account_id, external_object_url)
    VALUES (?, 1, ?, 'caldav', ?, ?)
  `).run(title, uid, accountId, url).lastInsertRowid);
  return { id, url };
}

const task = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const todoTombstones = () => db.prepare('SELECT * FROM caldav_todo_pending_deletions').all();

/** Ein für Termine ausgewählter Kalender, ebenfalls mit einem Nachbarn. */
function calendar(slug = 'family', name = 'Familie') {
  const url = dav.addCollection(slug, { name, components: ['VEVENT'] });
  dav.putObject(url, `${slug}-neighbour.ics`, vevent(`${slug}-neighbour@test`, 'Nachbar'));
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, ?, '#4A90E2', 1)
  `).run(accountId, url, name);
  const refId = db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav', ?, ?, '#4A90E2')
    RETURNING id
  `).get(url, name).id;
  return { url, refId };
}

function localEvent(calendarUrl, title = 'Hier angelegt') {
  return Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source,
       target_caldav_account_id, target_caldav_calendar_url)
    VALUES (?, '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, 'local', ?, ?)
  `).run(title, accountId, calendarUrl).lastInsertRowid);
}

function mirroredEvent(cal, uid, title) {
  const { url } = dav.putObject(cal.url, `${uid}.ics`, vevent(uid, title));
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source,
       external_calendar_id, calendar_ref_id, external_object_url)
    VALUES (?, '2035-03-10T09:00Z', '2035-03-10T10:00Z', 0, 1, 'caldav', ?, ?, ?)
  `).run(title, uid, cal.refId, url).lastInsertRowid);
  return { id, url };
}

const event = (id) => db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
const eventTombstones = () => db.prepare('SELECT * FROM calendar_pending_deletions').all();

/** Die Absage muss am Server angekommen sein - sonst belegt der Rest nichts. */
function assertRefused(method, status) {
  const hits = dav.seen(method).filter((r) => r.status === status);
  assert.ok(hits.length > 0, `der Server hat kein ${method} mit ${status} beantwortet`);
}

// ── Die Regel selbst: der Client-Wrapper gegen echtes HTTP ──────────────────────

test('Wrapper: die drei Schreibaufrufe werfen bei einer Absage, mit Status', async () => {
  reset();
  const cal = dav.addCollection('w', { name: 'W' });
  const { url, etag } = dav.putObject(cal, 'there.ics', vevent('there@test', 'Da'));
  const client = await createCalDAVClient({ caldav_url: dav.url, username: 'u', password: 'p' });

  const calls = {
    createCalendarObject: () => client.createCalendarObject({
      calendar: { url: cal }, filename: 'new.ics', iCalString: vevent('new@test', 'Neu'),
    }),
    updateCalendarObject: () => client.updateCalendarObject({
      calendarObject: { url, etag, data: vevent('there@test', 'Geändert') },
    }),
    deleteCalendarObject: () => client.deleteCalendarObject({ calendarObject: { url, etag } }),
  };
  const methodOf = { createCalendarObject: 'PUT', updateCalendarObject: 'PUT', deleteCalendarObject: 'DELETE' };

  for (const status of [403, 412, 500, 503, 507]) {
    for (const [name, call] of Object.entries(calls)) {
      dav.allowAll();
      dav.refuse({ method: methodOf[name], status });
      await assert.rejects(call, (err) => {
        assert.ok(err instanceof DavHttpError, `${name} ${status}: kein DavHttpError`);
        assert.equal(err.status, status, `${name}: Status fehlt am Fehler`);
        assert.equal(err.code, undefined, 'code muss leer bleiben, die Einordnung liest es zuerst');
        assert.doesNotMatch(err.message, /CalendarObject|fetchCalendars/, 'die Meldung nennt einen internen Funktionsnamen');
        assert.match(err.message, new RegExp(`HTTP ${status}`));
        return true;
      }, `${name} löste bei ${status} auf`);
    }
  }
  assert.deepEqual(dav.objectNames(cal), ['there.ics'], 'eine abgelehnte Anfrage hat den Server verändert');

  // Und der Erfolg kommt weiterhin durch, samt Antwort.
  dav.allowAll();
  assert.equal((await calls.createCalendarObject()).status, 201);
  assert.equal((await calls.updateCalendarObject()).status, 204);
  assert.equal((await client.deleteCalendarObject({ calendarObject: { url } })).status, 204);
});

test('Wrapper: was tsdav wirklich meldet, ordnet die bestehende Einordnung richtig ein', async () => {
  reset();
  const cal = dav.addCollection('w', { name: 'W' });
  const client = await createCalDAVClient({ caldav_url: dav.url, username: 'u', password: 'p' });
  const refusal = async (status) => {
    dav.allowAll();
    dav.refuse({ method: 'DELETE', status });
    return client.deleteCalendarObject({ calendarObject: { url: `${cal}x.ics` } }).then(
      () => assert.fail(`DELETE ${status} löste auf`), (err) => err
    );
  };

  // Nicht mehr da: das Ziel ist erreicht.
  assert.equal(classifyOutboundError(await refusal(404)), 'settled');
  assert.equal(classifyOutboundError(await refusal(410)), 'settled');
  // Der Server hält die Anfrage selbst für falsch: wiederholt sich garantiert.
  assert.equal(classifyOutboundError(await refusal(400)), 'permanent');
  // Alles andere wird wiederholt und nach MAX_OUTBOUND_ATTEMPTS aufgegeben.
  for (const status of [403, 412, 500, 503, 507]) {
    const err = await refusal(status);
    assert.equal(classifyOutboundError(err), 'retry', `HTTP ${status}`);
    assert.equal(outboundFailureAction(err, 0), 'retry', `HTTP ${status}, erster Versuch`);
    assert.equal(outboundFailureAction(err, MAX_OUTBOUND_ATTEMPTS - 1), 'give-up', `HTTP ${status}, letzter Versuch`);
  }
});

test('Wrapper: eine abgelehnte Auflistung ist keine leere Liste', async () => {
  reset();
  dav.addCollection('a', { name: 'A' });
  dav.addCollection('book', { name: 'Buch', kind: 'addressbook' });
  const calClient  = await createCalDAVClient({ caldav_url: dav.url, username: 'u', password: 'p' });
  const cardClient = await createCardDAVClient({ carddav_url: dav.url, username: 'u', password: 'p' });

  assert.equal((await calClient.fetchCalendars()).length, 1);
  assert.equal((await cardClient.fetchAddressBooks()).length, 1);

  for (const status of [401, 403, 404, 500, 503]) {
    dav.allowAll();
    dav.refuse({ method: 'PROPFIND', path: '/cal/', status });
    await assert.rejects(() => calClient.fetchCalendars(), (err) => err.status === status,
      `fetchCalendars löste bei ${status} auf`);
    await assert.rejects(() => cardClient.fetchAddressBooks(), (err) => err.status === status,
      `fetchAddressBooks löste bei ${status} auf`);
  }

  // Eine Absage mit XML-Körper, wie sabre-basierte Server (Nextcloud, Baikal)
  // sie schicken. Der Inhaltstyp allein darf sie nicht zur Auflistung machen:
  // ohne die Prüfung auf den Status ginge genau diese Absage als leere Liste durch.
  dav.allowAll();
  dav.refuse({ method: 'PROPFIND', path: '/cal/', status: 503, contentType: 'application/xml; charset=utf-8', body: dav.xmlError() });
  await assert.rejects(() => calClient.fetchCalendars(), (err) => err.status === 503,
    'eine Absage mit XML-Körper ging als Auflistung durch');
  await assert.rejects(() => cardClient.fetchAddressBooks(), (err) => err.status === 503);

  // Die Anmeldeseite eines vorgeschalteten Proxys: 200, aber keine Auflistung.
  dav.allowAll();
  dav.refuse({ method: 'PROPFIND', path: '/cal/', status: 200, contentType: 'text/html', body: '<html>Sign in</html>' });
  await assert.rejects(() => calClient.fetchCalendars(), /did not answer with a list of calendars/);

  // Eine einzelne Collection, die ihre Zusatzabfrage verweigert, kippt die
  // Liste nicht: geprüft wird nur die Auflistung selbst.
  dav.allowAll();
  dav.refuse({ method: 'PROPFIND', path: '/cal/a/', status: 403 });
  assert.equal((await calClient.fetchCalendars()).length, 1);

  // Ein Konto, das wirklich nichts hat, bleibt eine leere Liste.
  dav.reset();
  assert.deepEqual(await calClient.fetchCalendars(), []);
});

test('Wrapper: nur der belegte Erfolg zählt, und der Rest des Clients bleibt', async () => {
  class FutureClient {
    async createCalendarObject() { return undefined; }           // neue, unbekannte Rückgabeform
    async updateCalendarObject() { return { ok: true, status: 204 }; }
    async deleteCalendarObject() { return { ok: false, status: 423, statusText: 'Locked' }; }
    fetchCalendarObjects() { return 'aus dem Prototyp'; }
  }
  const client = withHttpRefusalsAsErrors(new FutureClient());

  await assert.rejects(() => client.createCalendarObject({}), DavHttpError,
    'eine Antwort ohne ok ging als Erfolg durch');
  assert.equal((await client.updateCalendarObject({})).status, 204);
  await assert.rejects(() => client.deleteCalendarObject({ calendarObject: { url: 'x' } }),
    (err) => err.status === 423 && err.url === 'x');
  assert.equal(client.fetchCalendarObjects(), 'aus dem Prototyp', 'Methode am Prototyp verloren');
});

// ── Aufgaben und Einkauf (VTODO) ────────────────────────────────────────────────

for (const status of [403, 412, 503, 507]) {
  test(`Aufgabe anlegen, PUT ${status}: bleibt lokal und übersteht den nächsten Abruf`, async () => {
    reset();
    const list = taskList();
    const id   = localTask(list);

    dav.refuse({ method: 'PUT', status });
    await todoOutbound.flushOutbound();
    assertRefused('PUT', status);

    let row = task(id);
    assert.equal(row.external_source, 'local', 'ein abgelehnter Upload wurde als Spiegel gestempelt');
    assert.equal(row.external_object_url, null, 'die Zeile zeigt auf ein Objekt, das es nicht gibt');
    assert.equal(row.target_caldav_list_url, list, 'das Ziel ist verloren, der Upload käme nie wieder');

    // Der Lauf, der den Schaden anrichtete: die Liste liefert die Aufgabe
    // nicht, und was als Spiegel galt, wurde als "auf dem Server gelöscht"
    // weggeräumt.
    await remindersSync.sync();
    row = task(id);
    assert.ok(row, 'die Aufgabe ist nach dem nächsten Abruf weg');
    assert.equal(row.external_source, 'local');
    assert.deepEqual(dav.objectNames(list), ['neighbour.ics']);

    // Sobald der Server annimmt, geht sie hinaus.
    dav.allowAll();
    await todoOutbound.flushOutbound();
    row = task(id);
    assert.equal(row.external_source, 'caldav');
    assert.ok(dav.getObject(list, `${row.external_uid}.ics`), 'das Objekt liegt nicht auf dem Server');
  });
}

for (const status of [403, 412, 503]) {
  test(`Aufgabe ändern, PUT ${status}: die Bearbeitung bleibt vorgemerkt und lokal erhalten`, async () => {
    reset();
    const list = taskList();
    const { id } = mirroredTask(list, 'todo-1@test', 'Alter Titel');
    db.prepare("UPDATE tasks SET title = 'Neuer Titel', outbound_dirty = 1 WHERE id = ?").run(id);

    dav.refuse({ method: 'PUT', status });
    await todoOutbound.flushOutbound();
    assertRefused('PUT', status);

    let row = task(id);
    assert.equal(row.outbound_dirty, 1, 'eine abgelehnte Änderung gilt als übertragen');
    assert.equal(row.outbound_attempts, 1, 'der Fehlversuch wurde nicht gezählt');
    assert.match(dav.getObject(list, 'todo-1@test.ics').data, /SUMMARY:Alter Titel/);

    // Ohne Vormerkung überschrieb der nächste Abruf die Bearbeitung mit dem
    // alten Serverstand.
    await remindersSync.sync();
    row = task(id);
    assert.equal(row.title, 'Neuer Titel', 'der Abruf hat die lokale Bearbeitung überschrieben');
    assert.equal(row.outbound_dirty, 1);

    dav.allowAll();
    await todoOutbound.flushOutbound();
    assert.equal(task(id).outbound_dirty, 0);
    assert.match(dav.getObject(list, 'todo-1@test.ics').data, /SUMMARY:Neuer Titel/);
  });

  test(`Aufgabe löschen, DELETE ${status}: der Tombstone bleibt, der Eintrag kehrt nicht zurück`, async () => {
    reset();
    const list = taskList();
    const { url } = dav.putObject(list, 'gone.ics', vtodo('gone@test', 'Gelöscht'));
    db.prepare(`
      INSERT INTO caldav_todo_pending_deletions (account_id, module, uid, object_url)
      VALUES (?, 'tasks', 'gone@test', ?)
    `).run(accountId, url);

    dav.refuse({ method: 'DELETE', status });
    await todoOutbound.flushOutbound();
    assertRefused('DELETE', status);

    assert.equal(todoTombstones().length, 1, 'ein abgelehntes Löschen hat den Tombstone verworfen');
    assert.equal(todoTombstones()[0].attempts, 1, 'der Fehlversuch wurde nicht gezählt');
    assert.ok(dav.getObject(list, 'gone.ics'));

    // Ohne Tombstone legte der nächste Abruf die gelöschte Aufgabe neu an.
    await remindersSync.sync();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE external_uid = 'gone@test'").get().n, 0,
      'die gelöschte Aufgabe ist zurück'
    );

    dav.allowAll();
    await todoOutbound.flushOutbound();
    assert.equal(todoTombstones().length, 0);
    assert.equal(dav.getObject(list, 'gone.ics'), null);
  });
}

test('Aufgabe löschen, DELETE 404: weg ist weg, der Tombstone ist erledigt', async () => {
  reset();
  const list = taskList();
  db.prepare(`
    INSERT INTO caldav_todo_pending_deletions (account_id, module, uid, object_url)
    VALUES (?, 'tasks', 'never@test', ?)
  `).run(accountId, `${list}never.ics`);

  await todoOutbound.flushOutbound();
  assertRefused('DELETE', 404);
  assert.equal(todoTombstones().length, 0, 'ein 404 hält den Tombstone fest');
});

test('Einkaufsartikel anlegen, PUT 403: bleibt lokal und übersteht den nächsten Abruf', async () => {
  reset();
  const { url, listId } = shoppingList();
  const id = Number(db.prepare(
    "INSERT INTO shopping_items (list_id, name) VALUES (?, 'Milch')"
  ).run(listId).lastInsertRowid);
  const item = () => db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id);

  dav.refuse({ method: 'PUT', status: 403 });
  await todoOutbound.flushOutbound();
  assertRefused('PUT', 403);
  assert.equal(item().external_source, 'local', 'ein abgelehnter Upload wurde als Spiegel gestempelt');

  await remindersSync.sync();
  assert.ok(item(), 'der Artikel ist nach dem nächsten Abruf weg');
  assert.equal(item().external_source, 'local');

  dav.allowAll();
  await todoOutbound.flushOutbound();
  assert.equal(item().external_source, 'caldav');
  assert.equal(dav.objectNames(url).length, 2);
});

test('Erinnerungslisten: eine abgelehnte Auflistung schaltet keine Liste ab und gibt kein Ziel frei', async () => {
  reset();
  const list = taskList();
  const id   = localTask(list);
  const enabled = () => db.prepare('SELECT enabled FROM caldav_reminder_selection WHERE list_url = ?').get(list).enabled;

  dav.refuse({ method: 'PROPFIND', path: '/cal/', status: 503 });

  await remindersSync.sync();
  assertRefused('PROPFIND', 503);
  assert.equal(enabled(), 1, 'die Liste wurde abgeschaltet, weil der Server gerade nicht antwortete');

  // Der Sofortversuch las die leere Antwort als "Ziel verschwunden" und gab
  // die Aufgabe frei - sie wäre nie wieder hochgeladen worden.
  await todoOutbound.flushOutbound();
  assert.equal(task(id).target_caldav_list_url, list, 'das Upload-Ziel der Aufgabe ist weg');

  dav.allowAll();
  await remindersSync.sync();
  assert.equal(task(id).external_source, 'caldav');
});

// ── Termine (VEVENT) ────────────────────────────────────────────────────────────

for (const status of [403, 412, 503, 507]) {
  test(`Termin anlegen, PUT ${status}: bleibt lokal und übersteht den nächsten Abruf`, async () => {
    reset();
    const cal = calendar();
    const id  = localEvent(cal.url);

    dav.refuse({ method: 'PUT', status });
    await caldavSync.sync();
    assertRefused('PUT', status);

    let row = event(id);
    assert.equal(row.external_source, 'local', 'ein abgelehnter Upload wurde als Spiegel gestempelt');
    assert.equal(row.external_object_url, null);

    await caldavSync.sync();
    row = event(id);
    assert.ok(row, 'der Termin ist nach dem nächsten Abruf weg');
    assert.equal(row.external_source, 'local');

    dav.allowAll();
    await caldavSync.sync();
    row = event(id);
    assert.equal(row.external_source, 'caldav');
    assert.ok(dav.getObject(cal.url, `${row.external_calendar_id}.ics`), 'das Objekt liegt nicht auf dem Server');
  });
}

for (const status of [403, 412, 503]) {
  test(`Termin ändern, PUT ${status}: die Bearbeitung bleibt vorgemerkt`, async () => {
    reset();
    const cal = calendar();
    const { id } = mirroredEvent(cal, 'evt-1@test', 'Alter Titel');
    db.prepare("UPDATE calendar_events SET title = 'Neuer Titel', outbound_dirty = 1 WHERE id = ?").run(id);

    dav.refuse({ method: 'PUT', status });
    await caldavSync.flushOutbound();
    assertRefused('PUT', status);

    let row = event(id);
    assert.equal(row.outbound_dirty, 1, 'eine abgelehnte Änderung gilt als übertragen');
    assert.equal(row.outbound_attempts, 1, 'der Fehlversuch wurde nicht gezählt');

    // Der Abruf lässt eine wartende Bearbeitung stehen - aber nur, solange
    // sie noch als wartend gilt.
    await caldavSync.sync();
    row = event(id);
    assert.equal(row.title, 'Neuer Titel', 'der Abruf hat die lokale Bearbeitung überschrieben');

    dav.allowAll();
    await caldavSync.flushOutbound();
    assert.equal(event(id).outbound_dirty, 0);
    assert.match(dav.getObject(cal.url, 'evt-1@test.ics').data, /SUMMARY:Neuer Titel/);
  });

  test(`Termin löschen, DELETE ${status}: der Tombstone bleibt, der Termin kehrt nicht zurück`, async () => {
    reset();
    const cal = calendar();
    const { url } = dav.putObject(cal.url, 'gone.ics', vevent('gone@test', 'Gelöscht'));
    db.prepare(`
      INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url)
      VALUES ('caldav', ?, 'gone@test', ?)
    `).run(cal.url, url);

    dav.refuse({ method: 'DELETE', status });
    await caldavSync.flushOutbound();
    assertRefused('DELETE', status);

    assert.equal(eventTombstones().length, 1, 'ein abgelehntes Löschen hat den Tombstone verworfen');
    assert.equal(eventTombstones()[0].attempts, 1, 'der Fehlversuch wurde nicht gezählt');

    await caldavSync.sync();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE external_calendar_id = 'gone@test'").get().n, 0,
      'der gelöschte Termin ist zurück'
    );

    dav.allowAll();
    await caldavSync.flushOutbound();
    assert.equal(eventTombstones().length, 0);
    assert.equal(dav.getObject(cal.url, 'gone.ics'), null);
  });
}

test('Termin umziehen, Kopie im Ziel abgelehnt (403): die Quelle bleibt stehen', async () => {
  reset();
  const source = calendar('family', 'Familie');
  const dest   = calendar('work', 'Arbeit');
  const { id } = mirroredEvent(source, 'move-1@test', 'Zieht um');
  db.prepare(`
    UPDATE calendar_events SET outbound_move_to = ?, target_caldav_calendar_url = ? WHERE id = ?
  `).run(dest.url, dest.url, id);

  // Nur das Anlegen im Ziel scheitert (etwa ein nur lesbar geteilter Kalender).
  dav.refuse({ method: 'PUT', status: 403 });
  await caldavSync.flushOutbound();
  assertRefused('PUT', 403);

  // Vorher lief das DELETE auf die Quelle trotzdem: der Termin war auf dem
  // Server ganz weg, und der nächste Abruf räumte ihn auch hier ab.
  assert.ok(dav.getObject(source.url, 'move-1@test.ics'), 'die Quelle wurde gelöscht, obwohl es keine Kopie gibt');
  assert.equal(dav.seen('DELETE').length, 0);
  let row = event(id);
  assert.equal(row.calendar_ref_id, source.refId, 'der Termin gilt als umgezogen');
  assert.equal(row.outbound_move_to, dest.url, 'der Umzug ist nicht mehr vorgemerkt');

  await caldavSync.sync();
  assert.ok(event(id), 'der Termin ist nach dem nächsten Abruf weg');

  dav.allowAll();
  await caldavSync.flushOutbound();
  row = event(id);
  assert.equal(row.calendar_ref_id, dest.refId);
  assert.ok(dav.getObject(dest.url, 'move-1@test.ics'));
  assert.equal(dav.getObject(source.url, 'move-1@test.ics'), null);
});

test('Kalender: eine abgelehnte Auflistung schaltet keinen Kalender ab und verwirft keinen Umzug', async () => {
  reset();
  const source = calendar('family', 'Familie');
  const dest   = calendar('work', 'Arbeit');
  const { id } = mirroredEvent(source, 'move-2@test', 'Zieht um');
  db.prepare(`
    UPDATE calendar_events SET outbound_move_to = ?, target_caldav_calendar_url = ? WHERE id = ?
  `).run(dest.url, dest.url, id);
  // Ein zweiter Termin mit einer schlichten Bearbeitung, NACH dem Umzug in der
  // Reihenfolge: bricht die Verarbeitung am Umzug ab statt ihn zu überspringen,
  // geht diese Bearbeitung nicht hinaus.
  const plain = mirroredEvent(source, 'plain-1@test', 'Alter Titel');
  db.prepare("UPDATE calendar_events SET title = 'Neuer Titel', outbound_dirty = 1 WHERE id = ?").run(plain.id);
  const enabled = () => db.prepare('SELECT COUNT(*) AS n FROM caldav_calendar_selection WHERE enabled = 1').get().n;

  dav.refuse({ method: 'PROPFIND', path: '/cal/', status: 503 });

  await caldavSync.sync();
  assertRefused('PROPFIND', 503);
  assert.equal(enabled(), 2, 'Kalender wurden abgeschaltet, weil der Server gerade nicht antwortete');

  // Der Sofortversuch braucht die Liste für das Umzugsziel. Unbekannt ist
  // nicht verschwunden: der Umzug wartet.
  await caldavSync.flushOutbound();
  assert.equal(event(id).outbound_move_to, dest.url, 'der wartende Umzug wurde verworfen');
  assert.equal(event(plain.id).outbound_dirty, 0, 'die Bearbeitung hinter dem wartenden Umzug ging nicht hinaus');
  assert.match(dav.getObject(source.url, 'plain-1@test.ics').data, /SUMMARY:Neuer Titel/);

  dav.allowAll();
  await caldavSync.flushOutbound();
  assert.equal(event(id).calendar_ref_id, dest.refId);
});

test('Apple-Kalender: ein abgelehnter Upload bleibt lokal', async () => {
  reset();
  const url = dav.addCollection('icloud', { name: 'iCloud' });
  dav.putObject(url, 'neighbour.ics', vevent('apple-neighbour@test', 'Nachbar'));
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  const id = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by, external_source)
    VALUES ('Hier angelegt', '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, 'local')
  `).run().lastInsertRowid);

  try {
    dav.refuse({ method: 'PUT', status: 403 });
    await appleCalendar.sync();
    assertRefused('PUT', 403);
    assert.equal(event(id).external_source, 'local', 'ein abgelehnter Upload wurde als Spiegel gestempelt');

    await appleCalendar.sync();
    assert.ok(event(id), 'der Termin ist nach dem nächsten Abruf weg');

    dav.allowAll();
    await appleCalendar.sync();
    assert.equal(event(id).external_source, 'apple');
  } finally {
    appleCalendar.clearCredentials();
  }
});

// ── Kontakte (CardDAV, nur lesend) ──────────────────────────────────────────────

test('Adressbücher: eine abgelehnte Auflistung schaltet kein Adressbuch ab', async () => {
  reset();
  const book = dav.addCollection('book', { name: 'Kontakte', kind: 'addressbook' });
  const cardAccount = Number(db.prepare(`
    INSERT INTO carddav_accounts (name, carddav_url, username, password) VALUES ('Fake', ?, 'u', 'p')
  `).run(dav.url).lastInsertRowid);
  db.prepare(`
    INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
    VALUES (?, ?, 'Kontakte', 1)
  `).run(cardAccount, book);
  const selection = () => db.prepare('SELECT enabled, last_error FROM carddav_addressbook_selection').get();

  dav.refuse({ method: 'PROPFIND', path: '/cal/', status: 503 });
  await assert.rejects(() => cardavSync.syncAccount(cardAccount), /503/);
  assertRefused('PROPFIND', 503);
  assert.equal(selection().enabled, 1, 'das Adressbuch wurde abgeschaltet, weil der Server gerade nicht antwortete');
  assert.match(
    db.prepare('SELECT last_error FROM carddav_accounts WHERE id = ?').get(cardAccount).last_error, /503/,
    'der Fehler steht nicht am Konto'
  );

  dav.allowAll();
  await cardavSync.syncAccount(cardAccount);
  assert.equal(selection().enabled, 1);
});

// ── Nachzug aus dem Review von #1837 ────────────────────────────────────────────

/** Antwortet auf die Auflistung mit einem gültigen, aber leeren Multistatus. */
function incompleteListing(body) {
  dav.refuse({ method: 'PROPFIND', path: '/cal/', status: 207, contentType: 'application/xml; charset=utf-8', body });
}

const INCOMPLETE = {
  'nur die Home-Collection':    () => dav.homeOnlyListing(),
  '403 je Ressource':           () => dav.forbiddenListing(),
};

for (const [shape, body] of Object.entries(INCOMPLETE)) {
  // Eine Auflistung, die ANKOMMT, aber keine Collection nennt, ist keine Absage:
  // der Wrapper lässt sie durch (ein leeres Konto sieht genauso aus). Die vier
  // Stellen, die daraus "verschwunden" lesen, brauchen ihren eigenen Leer-Guard.
  test(`Unvollständige Auflistung (${shape}): Kalender bleiben eingeschaltet`, async () => {
    reset();
    calendar('family', 'Familie');
    calendar('work', 'Arbeit');
    incompleteListing(body());

    const client = await createCalDAVClient({ caldav_url: dav.url, username: 'u', password: 'p' });
    assert.deepEqual(await client.fetchCalendars(), [], 'die Form löst nicht mehr zu einer leeren Liste auf - der Test misst etwas anderes');

    await caldavSync.sync();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM caldav_calendar_selection WHERE enabled = 1').get().n, 2,
      'eine Antwort ohne Kalender hat alle Kalender abgeschaltet');
  });

  test(`Unvollständige Auflistung (${shape}): Erinnerungslisten bleiben eingeschaltet`, async () => {
    reset();
    const list = taskList();
    incompleteListing(body());

    await remindersSync.sync();
    assert.equal(db.prepare('SELECT enabled FROM caldav_reminder_selection WHERE list_url = ?').get(list).enabled, 1,
      'eine Antwort ohne Collections hat die Liste abgeschaltet');
  });

  test(`Unvollständige Auflistung (${shape}): eine wartende Aufgabe behält ihr Ziel`, async () => {
    reset();
    const list = taskList();
    const id   = localTask(list);
    incompleteListing(body());

    await todoOutbound.flushOutbound();
    assert.ok(dav.seen('PROPFIND').some((r) => r.path === '/cal/' && r.status === 207), 'die Auflistung wurde nicht abgefragt');
    assert.equal(task(id).target_caldav_list_url, list, 'das Upload-Ziel der Aufgabe wurde geleert');

    dav.allowAll();
    await todoOutbound.flushOutbound();
    assert.equal(task(id).external_source, 'caldav');
  });

  test(`Unvollständige Auflistung (${shape}): Adressbücher bleiben eingeschaltet`, async () => {
    reset();
    const book = dav.addCollection('book', { name: 'Kontakte', kind: 'addressbook' });
    const cardAccount = Number(db.prepare(`
      INSERT INTO carddav_accounts (name, carddav_url, username, password) VALUES ('Fake', ?, 'u', 'p')
    `).run(dav.url).lastInsertRowid);
    db.prepare(`
      INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
      VALUES (?, ?, 'Kontakte', 1)
    `).run(cardAccount, book);
    incompleteListing(body());

    await assert.rejects(() => cardavSync.syncAccount(cardAccount), /listed no address books/);
    assert.equal(db.prepare('SELECT enabled FROM carddav_addressbook_selection').get().enabled, 1,
      'eine Antwort ohne Adressbücher hat das Adressbuch abgeschaltet');
    assert.match(db.prepare('SELECT last_error FROM carddav_accounts WHERE id = ?').get(cardAccount).last_error,
      /listed no address books/, 'der Fehler steht nicht am Konto');
  });
}

// ── Schranke je Lauf: eine ablehnende Collection kostet EINEN Versuch ───────────

test('Schranke: die erste Absage schliesst die Collection, eine Absage am Objekt nicht', async () => {
  const { createUploadGate, isCollectionRefusal } = await import('../server/utils/caldav-client.js');
  const refusal = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

  for (const status of [401, 403, 404, 429, 500, 503, 507]) {
    assert.equal(isCollectionRefusal(refusal(status)), true, `HTTP ${status}`);
  }
  // Netzfehler: kein Status, dieselbe Wand für jeden weiteren Versuch.
  assert.equal(isCollectionRefusal(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true);
  // Hängt am einzelnen Objekt: wer dahinter wartet, darf nicht ausgesperrt werden.
  for (const status of [400, 409, 412, 413, 415, 422]) {
    assert.equal(isCollectionRefusal(refusal(status)), false, `HTTP ${status}`);
  }

  const gate = createUploadGate();
  assert.equal(gate.isClosed('a'), false);
  assert.equal(gate.refused('a', refusal(412)), false, 'ein 412 hat die Collection geschlossen');
  assert.equal(gate.isClosed('a'), false);
  assert.equal(gate.refused('a', refusal(403)), true);
  assert.equal(gate.isClosed('a'), true);
  assert.equal(gate.isClosed('a'), true);
  assert.equal(gate.isClosed('b'), false, 'die Schranke gilt je Collection');

  // EINE Meldung je Collection, mit der Zahl aller wartenden Zeilen.
  const lines = [];
  gate.report((url, err, waiting) => lines.push([url, err.status, waiting]));
  assert.deepEqual(lines, [['a', 403, 3]]);
});

test('Schranke: drei wartende Aufgaben auf einer ablehnenden Liste kosten einen PUT je Lauf', async () => {
  reset();
  const list = taskList();
  const ids  = [localTask(list, 'Eins'), localTask(list, 'Zwei'), localTask(list, 'Drei')];

  dav.refuse({ method: 'PUT', status: 403 });
  await todoOutbound.flushOutbound();
  assert.equal(dav.seen('PUT').length, 1, 'jede wartende Aufgabe hat ihre eigene Absage abgeholt');
  await remindersSync.sync();
  assert.equal(dav.seen('PUT').length, 2, 'der Sync-Lauf hat mehr als einen Versuch gemacht');
  for (const id of ids) {
    assert.equal(task(id).external_source, 'local');
    assert.equal(task(id).target_caldav_list_url, list, 'eine übersprungene Aufgabe hat ihr Ziel verloren');
  }

  // Die Schranke gilt nur für den Lauf: nimmt der Server an, gehen alle hinaus.
  dav.allowAll();
  await todoOutbound.flushOutbound();
  for (const id of ids) assert.equal(task(id).external_source, 'caldav');
});

test('Schranke: eine Aufgabe, die der Server nie annimmt, hält die anderen nicht auf', async () => {
  reset();
  const list = taskList();
  const bad  = localTask(list, 'Kaputt');
  const good = [localTask(list, 'Zwei'), localTask(list, 'Drei')];

  // Die Absage hängt am Inhalt dieses einen Objekts, nicht an der Liste.
  dav.refuse({ method: 'PUT', status: 400, when: (req) => req.body.includes('SUMMARY:Kaputt') });
  await todoOutbound.flushOutbound();

  assert.equal(task(bad).external_source, 'local');
  for (const id of good) {
    assert.equal(task(id).external_source, 'caldav', 'eine Aufgabe hinter der abgelehnten blieb liegen');
  }
});

test('Schranke: drei Einkaufsartikel auf einer ablehnenden Liste kosten einen PUT je Sofortversuch', async () => {
  reset();
  const { listId } = shoppingList();
  for (const name of ['Milch', 'Brot', 'Eier']) {
    db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(listId, name);
  }

  dav.refuse({ method: 'PUT', status: 403 });
  await todoOutbound.flushOutbound();
  assert.equal(dav.seen('PUT').length, 1, 'jeder ungespiegelte Artikel wurde erneut geschickt');
  await todoOutbound.flushOutbound();
  assert.equal(dav.seen('PUT').length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shopping_items WHERE external_source = 'local'").get().n, 3);
});

test('Schranke: drei wartende Termine auf einem ablehnenden Kalender kosten einen PUT je Lauf', async () => {
  reset();
  const cal = calendar();
  const other = calendar('work', 'Arbeit');
  const ids = [localEvent(cal.url, 'Eins'), localEvent(cal.url, 'Zwei'), localEvent(cal.url, 'Drei')];
  const elsewhere = localEvent(other.url, 'Woanders');

  // Nur der eine Kalender lehnt ab; der andere nimmt weiter an.
  dav.refuse({ method: 'PUT', status: 403, when: (req) => req.path.startsWith('/cal/family/') });
  await caldavSync.sync();
  assert.equal(dav.seen('PUT').filter((r) => r.status === 403).length, 1,
    'jeder wartende Termin hat seine eigene Absage abgeholt');
  for (const id of ids) assert.equal(event(id).external_source, 'local');
  assert.equal(event(elsewhere).external_source, 'caldav', 'die Schranke hat einen anderen Kalender mitgeschlossen');
});

test('Schranke: der Apple-Kalender bekommt je Lauf einen Versuch, nicht einen je Termin', async () => {
  reset();
  const url = dav.addCollection('icloud', { name: 'iCloud' });
  dav.putObject(url, 'neighbour.ics', vevent('apple-neighbour@test', 'Nachbar'));
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  for (const title of ['Eins', 'Zwei', 'Drei']) {
    db.prepare(`
      INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by, external_source)
      VALUES (?, '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, 'local')
    `).run(title);
  }

  try {
    dav.refuse({ method: 'PUT', status: 403 });
    await appleCalendar.sync();
    await appleCalendar.sync();
    assert.equal(dav.seen('PUT').length, 2, 'drei Termine, zwei Läufe: mehr als zwei abgelehnte PUTs');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE external_source = 'local'").get().n, 3);
  } finally {
    appleCalendar.clearCredentials();
  }
});

// ── Umzug: was am ZIEL scheitert, trifft nicht den Termin ──────────────────────

function pendingMove(uid, { edited = false } = {}) {
  const source = calendar('family', 'Familie');
  const dest   = calendar('work', 'Arbeit');
  const { id } = mirroredEvent(source, uid, 'Alter Titel');
  db.prepare(`
    UPDATE calendar_events
       SET outbound_move_to = ?, target_caldav_calendar_url = ?,
           title = CASE WHEN ? = 1 THEN 'Neuer Titel' ELSE title END, outbound_dirty = ?
     WHERE id = ?
  `).run(dest.url, dest.url, edited ? 1 : 0, edited ? 1 : 0, id);
  return { source, dest, id };
}

test('Umzug im Sync-Lauf: ein abgelehnter Objektabruf am Ziel verwirft den Umzug nicht', async () => {
  reset();
  const { source, dest, id } = pendingMove('move-3@test');

  // Das Ziel steht in der Auflistung, nur sein REPORT scheitert. Ein Umzug
  // schreibt in das Ziel, er liest es nicht.
  dav.refuse({ method: 'REPORT', path: '/cal/work/', status: 503 });
  await caldavSync.sync();
  assertRefused('REPORT', 503);

  const row = event(id);
  assert.ok(row.outbound_move_to === dest.url || row.calendar_ref_id === dest.refId,
    'der wartende Umzug wurde verworfen, weil der Abruf des Ziels scheiterte');
  assert.equal(row.calendar_ref_id, dest.refId, 'der Umzug ist nicht gelaufen, obwohl die Auflistung das Ziel nennt');
  assert.ok(dav.getObject(dest.url, 'move-3@test.ics'));
  assert.equal(dav.getObject(source.url, 'move-3@test.ics'), null);
});

test('Umzug, Ziel antwortet 404 auf die Kopie: der Umzug fällt, die Bearbeitung nicht', async () => {
  reset();
  const { source, dest, id } = pendingMove('move-4@test', { edited: true });

  dav.refuse({ method: 'PUT', status: 404, when: (req) => req.path.startsWith('/cal/work/') });
  await caldavSync.flushOutbound();
  assertRefused('PUT', 404);

  let row = event(id);
  assert.equal(row.outbound_move_to, null, 'ein Ziel, das es nicht mehr gibt, wird weiter versucht');
  assert.equal(row.calendar_ref_id, source.refId);
  // "Nicht mehr da" galt dem Ziel. Vorher fiel damit auch die Bearbeitung, und
  // der nächste Abruf überschrieb "Neuer Titel" mit "Alter Titel".
  assert.match(dav.getObject(source.url, 'move-4@test.ics').data, /SUMMARY:Neuer Titel/,
    'die wartende Bearbeitung wurde mit dem Umzug verworfen');
  assert.equal(row.outbound_dirty, 0);

  dav.allowAll();
  await caldavSync.sync();
  row = event(id);
  assert.equal(row.title, 'Neuer Titel', 'der Abruf hat die Bearbeitung überschrieben');
  assert.equal(dav.objectNames(dest.url).includes('move-4@test.ics'), false);
});

test('Umzug, die Kopie liegt schon im Ziel (412): der Umzug schliesst ab', async () => {
  reset();
  const { source, dest, id } = pendingMove('move-5@test', { edited: true });
  // Ein früherer Versuch hat die Kopie angelegt und ist danach abgebrochen.
  dav.putObject(dest.url, 'move-5@test.ics', vevent('move-5@test', 'Alter Titel'));

  await caldavSync.flushOutbound();
  assertRefused('PUT', 412);

  const row = event(id);
  assert.equal(row.calendar_ref_id, dest.refId, 'der Umzug blieb an der eigenen Kopie hängen');
  assert.equal(row.outbound_move_to, null);
  assert.equal(dav.getObject(source.url, 'move-5@test.ics'), null, 'die Quelle steht noch: der Termin liegt doppelt');
  // Die Kopie stammt aus dem früheren Versuch; der Stand von jetzt muss drauf.
  assert.match(dav.getObject(dest.url, 'move-5@test.ics').data, /SUMMARY:Neuer Titel/,
    'die alte Kopie wurde übernommen, ohne den aktuellen Stand hinaufzutragen');
});

test('Umzug, an der Adresse im Ziel liegt ein FREMDES Objekt (412): die Quelle bleibt', async () => {
  reset();
  const { source, dest, id } = pendingMove('move-6@test');
  dav.putObject(dest.url, 'move-6@test.ics', vevent('somebody-else@test', 'Fremd'));

  await caldavSync.flushOutbound();
  assertRefused('PUT', 412);

  assert.ok(dav.getObject(source.url, 'move-6@test.ics'), 'die Quelle wurde gelöscht, obwohl im Ziel ein fremdes Objekt liegt');
  assert.match(dav.getObject(dest.url, 'move-6@test.ics').data, /SUMMARY:Fremd/, 'das fremde Objekt wurde überschrieben');
  const row = event(id);
  assert.equal(row.calendar_ref_id, source.refId);
  assert.equal(row.outbound_move_to, dest.url, 'der Umzug ist nicht mehr vorgemerkt');
  assert.equal(row.outbound_attempts, 1);
});

// ── CardDAV-Verbindungstest: die Absage erreicht den Nutzer ─────────────────────

test('CardDAV-Konto anlegen: eine Absage des Servers kommt als Meldung an, nicht als "Internal error"', async () => {
  reset();
  dav.addCollection('book', { name: 'Kontakte', kind: 'addressbook' });
  const express = (await import('express')).default;
  const { default: cardavRouter } = await import('../server/routes/cardav.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authRole = 'admin'; next(); });
  app.use('/cardav', cardavRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    dav.refuse({ method: 'PROPFIND', path: '/cal/', status: 403 });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/cardav/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fake', cardavUrl: dav.url, username: 'u', password: 'p' }),
    });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.errorCode, 'connection_failed');
    assert.match(body.error, /refused to list the address books \(HTTP 403/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM carddav_accounts').get().n, 0);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
