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
const {
  classifyOutboundError, outboundFailureAction, davFailureAction, MAX_OUTBOUND_ATTEMPTS, queueDeletion, queueEventDeletion,
  eventUidFor,
} = await import('../server/services/calendar-outbound.js');
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
    'carddav_addressbook_selection', 'carddav_accounts', 'caldav_upload_attempts',
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
       external_calendar_id, calendar_ref_id, external_object_url, caldav_account_id)
    VALUES (?, '2035-03-10T09:00Z', '2035-03-10T10:00Z', 0, 1, 'caldav', ?, ?, ?, ?)
  `).run(title, uid, cal.refId, url, accountId).lastInsertRowid);
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
  // Auf den Wegen über CalDAV zählt nur, was am Eintrag hängt (#1863): eine
  // Absage des Kontos oder des Servers lässt den Auftrag warten, ohne Versuch.
  for (const status of [401, 403, 429, 500, 503, 507]) {
    const err = await refusal(status);
    assert.equal(davFailureAction(err, 0), 'wait', `HTTP ${status}`);
    assert.equal(davFailureAction(err, MAX_OUTBOUND_ATTEMPTS - 1), 'wait', `HTTP ${status}, nach vier Absagen am Eintrag`);
  }
  for (const status of [409, 412, 413, 415, 422, 423]) {
    const err = await refusal(status);
    assert.equal(davFailureAction(err, 0), 'retry', `HTTP ${status}`);
    assert.equal(davFailureAction(err, MAX_OUTBOUND_ATTEMPTS - 1), 'give-up', `HTTP ${status}, letzter Versuch`);
  }
  assert.equal(davFailureAction(await refusal(400), 0), 'give-up');
  assert.equal(davFailureAction(await refusal(404), 0), 'settled');
  // Ohne Status: ein erkannter Netzfehler gilt dem Server, ein Fehler aus
  // dem eigenen Code (ICS-Bau, Buchung) der einen Zeile.
  const offline = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
  assert.equal(davFailureAction(offline, MAX_OUTBOUND_ATTEMPTS - 1), 'wait');
  assert.equal(davFailureAction(new Error('kaputtes ICS'), MAX_OUTBOUND_ATTEMPTS - 1), 'give-up');
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

/**
 * Versuche, die EINE Absage am Auftrag verbraucht (#1863): 412 hängt am
 * Eintrag, 403 und 503 gelten dem Konto oder dem Server und zählen nicht.
 */
const countedAttempts = (status) => ({ 403: 0, 412: 1, 503: 0 })[status];

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
    assert.equal(row.outbound_attempts, countedAttempts(status), 'der Fehlversuch wurde falsch gezählt');
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
    assert.equal(todoTombstones()[0].attempts, countedAttempts(status), 'der Fehlversuch wurde falsch gezählt');
    assert.match(todoTombstones()[0].last_error, new RegExp(`HTTP ${status}`), 'die Absage steht nicht am Auftrag');
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
    assert.equal(row.outbound_attempts, countedAttempts(status), 'der Fehlversuch wurde falsch gezählt');

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
      INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url, caldav_account_id)
      VALUES ('caldav', ?, 'gone@test', ?, ?)
    `).run(cal.url, url, accountId);

    dav.refuse({ method: 'DELETE', status });
    await caldavSync.flushOutbound();
    assertRefused('DELETE', status);

    assert.equal(eventTombstones().length, 1, 'ein abgelehntes Löschen hat den Tombstone verworfen');
    assert.equal(eventTombstones()[0].attempts, countedAttempts(status), 'der Fehlversuch wurde falsch gezählt');
    assert.match(eventTombstones()[0].last_error, new RegExp(`HTTP ${status}`), 'die Absage steht nicht am Auftrag');

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

// `refused`: woran der Aufruf die Form erkennt. Eine Auflistung ohne
// Collection löst zu einer leeren Liste auf; eine, in der jede Ressource mit
// 403 abgelehnt ist, ist eine Absage wie eine an der ganzen Anfrage - mit
// Status und Nutzertext (tsdav 2.4.0 wirft hier selbst, aber ohne Status).
// Beides ist keine Auskunft "es gibt keine" - die Collections bleiben.
const INCOMPLETE = {
  'nur die Home-Collection':    { body: () => dav.homeOnlyListing(), refused: null },
  '403 je Ressource':           { body: () => dav.forbiddenListing(), refused: /refused to list the (calendars|address books) \(HTTP 403/ },
};

for (const [shape, { body, refused }] of Object.entries(INCOMPLETE)) {
  // Eine Auflistung, die ANKOMMT, aber keine Collection nennt, ist keine Absage:
  // der Wrapper lässt sie durch (ein leeres Konto sieht genauso aus). Die vier
  // Stellen, die daraus "verschwunden" lesen, brauchen ihren eigenen Leer-Guard.
  test(`Unvollständige Auflistung (${shape}): Kalender bleiben eingeschaltet`, async () => {
    reset();
    calendar('family', 'Familie');
    calendar('work', 'Arbeit');
    incompleteListing(body());

    const client = await createCalDAVClient({ caldav_url: dav.url, username: 'u', password: 'p' });
    if (refused) {
      await assert.rejects(() => client.fetchCalendars(), (err) => err.status === 403 && refused.test(err.message),
        'die Form geht nicht als Absage mit Status hinaus');
    } else {
      assert.deepEqual(await client.fetchCalendars(), [], 'die Form löst nicht mehr zu einer leeren Liste auf - der Test misst etwas anderes');
    }

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

    const reported = refused ?? /listed no address books/;
    await assert.rejects(() => cardavSync.syncAccount(cardAccount), reported);
    assert.equal(db.prepare('SELECT enabled FROM carddav_addressbook_selection').get().enabled, 1,
      'eine Antwort ohne Adressbücher hat das Adressbuch abgeschaltet');
    assert.match(db.prepare('SELECT last_error FROM carddav_accounts WHERE id = ?').get(cardAccount).last_error,
      reported, 'der Fehler steht nicht am Konto');
  });
}

// ── Schranke je Lauf: eine ablehnende Collection kostet EINEN Versuch ───────────

test('Schranke: die erste Absage schliesst die Collection, eine Absage am Objekt nicht', async () => {
  const { createUploadGate, isCollectionRefusal } = await import('../server/utils/caldav-client.js');
  const refusal = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

  for (const status of [401, 403, 404, 429, 500, 503, 507]) {
    assert.equal(isCollectionRefusal(refusal(status)), true, `HTTP ${status}`);
  }
  // Netzfehler: kein Status, dieselbe Wand für jeden weiteren Versuch. In den
  // Formen, in denen er wirklich ankommt: Code am Fehler (node-fetch), Code an
  // der Ursache (fetch von Node: `TypeError: fetch failed`), Abbruch per Timeout.
  const network = [
    Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('x'), { name: 'FetchError', code: 'ENOTFOUND' }),
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('y'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }),
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('y'), { code: 'ECONNRESET' }) }),
    Object.assign(new TypeError('fetch failed'), { cause: new Error('bad port') }),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
    Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
  ];
  for (const err of network) {
    assert.equal(isCollectionRefusal(err), true, `${err.name} ${err.code ?? err.cause?.code ?? ''}`);
  }
  // Kein Status und kein Netzfehler: ein Fehler aus dem eigenen Code (ICS-Bau,
  // die Buchung nach dem PUT). Der hängt an DIESER Zeile - schlösse er die
  // Collection, sperrte eine einzige kaputte Zeile alle dahinter aus, bei jedem
  // Lauf und ohne eigene Logzeile.
  const local = [
    new Error('boom'),
    new TypeError("Cannot read properties of undefined (reading 'x')"),
    new RangeError('Invalid time value'),
    Object.assign(new Error('constraint failed'), { code: 'ERR_SQLITE_ERROR', errcode: 1811 }),
    Object.assign(new Error('constraint failed'), { code: 'SQLITE_CONSTRAINT_TRIGGER' }),
    Object.assign(new TypeError('The "url" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' }),
    null,
    undefined,
  ];
  for (const err of local) {
    assert.equal(isCollectionRefusal(err), false, `ein eigener Fehler (${err?.code ?? err?.message}) galt als Absage der Collection`);
  }
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

test('Schranke: ein Termin, dessen Buchung hier scheitert, hält die anderen nicht auf', async () => {
  reset();
  const cal = calendar();
  const bad  = localEvent(cal.url, 'Kaputt');
  const good = [localEvent(cal.url, 'Zwei'), localEvent(cal.url, 'Drei')];

  // Der PUT geht durch, das Festhalten danach nicht: ein Fehler OHNE Status,
  // aus dem eigenen Code. Er sagt nichts über den Kalender.
  db.exec(`
    CREATE TRIGGER test_bad_event_booking BEFORE UPDATE OF external_source ON calendar_events
    WHEN NEW.title = 'Kaputt' AND NEW.external_source = 'caldav'
    BEGIN SELECT RAISE(ABORT, 'booking failed'); END
  `);
  try {
    await caldavSync.sync();
  } finally {
    db.exec('DROP TRIGGER test_bad_event_booking');
  }

  assert.equal(event(bad).external_source, 'local', 'VORBEDINGUNG: der Trigger hat die Buchung nicht verhindert');
  for (const id of good) {
    assert.equal(event(id).external_source, 'caldav', 'ein Termin hinter dem gescheiterten blieb liegen');
  }
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

// ── Umzug: die QUELLE lehnt das Löschen ab (#1861) ──────────────────────────────
//
// Die Kopie liegt im Ziel, das DELETE der Quelle scheitert. Vorher galt der
// Umzug damit als vollzogen und wurde nie wiederholt: das Objekt lag für immer
// in beiden Kalendern, jeder andere Client des Kontos zeigte den Termin
// doppelt, und die Zeile folgte dem Kalender, den der Lauf zuletzt las.

const eventRows = (uid) => db.prepare(
  'SELECT * FROM calendar_events WHERE external_calendar_id = ? ORDER BY id'
).all(uid);
// 409: eine Absage am Eintrag selbst, die als Versuch zählt. Eine kontoweite
// (403, 503) zählt nicht (#1863), siehe den Fall weiter unten.
const refuseSourceDelete = (status = 409) => dav.refuse({
  method: 'DELETE', status, when: (req) => req.path.startsWith('/cal/family/'),
});

/**
 * Wie `pendingMove`, aber mit wählbarer Reihenfolge der Kalender: der Lauf
 * liest sie in der Reihenfolge der Auswahl, und der Fehler hing daran, welcher
 * zuletzt kam.
 */
function pendingMoveInOrder(uid, sourceFirst) {
  let source; let dest;
  if (sourceFirst) { source = calendar('family', 'Familie'); dest = calendar('work', 'Arbeit'); }
  else { dest = calendar('work', 'Arbeit'); source = calendar('family', 'Familie'); }
  const { id } = mirroredEvent(source, uid, 'Zieht um');
  db.prepare(`
    UPDATE calendar_events SET outbound_move_to = ?, target_caldav_calendar_url = ? WHERE id = ?
  `).run(dest.url, dest.url, id);
  return { source, dest, id };
}

for (const sourceFirst of [true, false]) {
  const order = sourceFirst ? 'Quelle zuerst gelesen' : 'Quelle zuletzt gelesen';

  test(`Umzug, die Quelle lehnt das Löschen ab (409), ${order}: es wird wiederholt, der Termin liegt am Ende einmal`, async () => {
    reset();
    const uid = 'move-7@test';
    const { source, dest, id } = pendingMoveInOrder(uid, sourceFirst);

    refuseSourceDelete();
    await caldavSync.flushOutbound();
    assertRefused('DELETE', 409);
    assert.ok(dav.getObject(dest.url, `${uid}.ics`), 'die Kopie im Ziel fehlt - der Fall ist nicht nachgestellt');
    assert.ok(dav.getObject(source.url, `${uid}.ics`));

    // Die Zeile gehört dem Ziel, und das offene Löschen der Quelle ist gebucht.
    let row = event(id);
    assert.equal(row.calendar_ref_id, dest.refId);
    assert.equal(row.outbound_move_to, null);
    let pending = eventTombstones();
    assert.equal(pending.length, 1, 'das abgelehnte Löschen der Quelle ist nirgends vorgemerkt');
    assert.equal(pending[0].calendar_external_id, source.url);
    assert.equal(pending[0].object_url, `${source.url}${uid}.ics`);
    assert.equal(pending[0].event_external_id, uid);
    assert.equal(pending[0].caldav_account_id, accountId, 'der Auftrag gehört nicht dem Konto der Zeile');
    assert.equal(pending[0].attempts, 1, 'die Absage wurde nicht als Versuch gezählt');

    // Ein Lauf, in dem die Quelle weiter ablehnt: EINE Zeile, am Ziel - gleich,
    // welcher Kalender zuletzt gelesen wird, und die Kopie im Ziel ist nicht
    // hinter der Vormerkung verschwunden.
    await caldavSync.sync();
    assert.equal(eventRows(uid).length, 1);
    row = event(id);
    assert.ok(row, 'die Zeile ist weg: die Vormerkung hat die Kopie im Ziel verdeckt');
    assert.equal(row.calendar_ref_id, dest.refId, 'die Zeile ist zur Quelle zurückgewandert');
    assert.equal(row.external_object_url, `${dest.url}${uid}.ics`);
    assert.equal(eventTombstones()[0].attempts, 2);

    // Der Auftrag verdeckt nur das Objekt in der Quelle: was ein anderer
    // Client inzwischen an der Kopie im Ziel ändert, kommt weiter an.
    dav.putObject(dest.url, `${uid}.ics`, vevent(uid, 'Im Ziel geändert'));
    await caldavSync.sync();
    assert.equal(event(id).title, 'Im Ziel geändert', 'der Auftrag für die Quelle verdeckt auch die Kopie im Ziel');
    assert.equal(event(id).calendar_ref_id, dest.refId);
    assert.equal(eventTombstones()[0].attempts, 3);

    // Eine Bearbeitung in dieser Zeit geht an die Kopie im Ziel.
    db.prepare("UPDATE calendar_events SET title = 'Neuer Titel', outbound_dirty = 1 WHERE id = ?").run(id);
    await caldavSync.sync();
    assert.match(dav.getObject(dest.url, `${uid}.ics`).data, /SUMMARY:Neuer Titel/,
      'die Bearbeitung ging nicht an die Kopie im Ziel');
    assert.equal(event(id).outbound_dirty, 0);
    assert.match(dav.getObject(source.url, `${uid}.ics`).data, /SUMMARY:Zieht um/);

    // Der Server lässt wieder alles zu: der nächste Lauf räumt die Quelle ab.
    dav.allowAll();
    await caldavSync.sync();
    assert.equal(dav.getObject(source.url, `${uid}.ics`), null, 'der Termin liegt weiter in beiden Kalendern');
    assert.ok(dav.getObject(dest.url, `${uid}.ics`), 'die Kopie im Ziel wurde mit abgeräumt');
    assert.equal(eventTombstones().length, 0);

    // Und es bleibt dabei.
    await caldavSync.sync();
    assert.equal(eventRows(uid).length, 1);
    row = event(id);
    assert.equal(row.calendar_ref_id, dest.refId);
    assert.equal(row.title, 'Neuer Titel');
    assert.ok(dav.getObject(dest.url, `${uid}.ics`));
  });
}

test('Umzug, die Quelle lehnt das Löschen ab: Kalender und Adresse des Auftrags stammen von dem Objekt, an das das DELETE ging', async () => {
  reset();
  const uid = 'move-9@test';
  // Die Zeile glaubt, in `family` zu liegen; das Objekt liegt inzwischen in
  // `school` (auf dem Server verschoben). Eine wartende Bearbeitung hält den
  // Abruf davon ab, die Zeile vorher nachzuziehen.
  const family = calendar('family', 'Familie');
  const school = calendar('school', 'Schule');
  const dest   = calendar('work', 'Arbeit');
  const { id } = mirroredEvent(family, uid, 'Zieht um');
  dav.putObject(school.url, `${uid}.ics`, dav.getObject(family.url, `${uid}.ics`).data);
  await fetch(`${family.url}${uid}.ics`, { method: 'DELETE' });
  dav.requests.length = 0;
  db.prepare(`
    UPDATE calendar_events SET outbound_dirty = 1, outbound_move_to = ?, target_caldav_calendar_url = ? WHERE id = ?
  `).run(dest.url, dest.url, id);

  dav.refuse({ method: 'DELETE', status: 403, when: (req) => req.path.startsWith('/cal/school/') });
  await caldavSync.sync();
  assertRefused('DELETE', 403);
  assert.ok(dav.getObject(dest.url, `${uid}.ics`), 'die Kopie im Ziel fehlt - der Fall ist nicht nachgestellt');

  const pending = eventTombstones();
  assert.equal(pending.length, 1, 'das abgelehnte Löschen ist nirgends vorgemerkt');
  assert.equal(pending[0].object_url, `${school.url}${uid}.ics`);
  assert.equal(pending[0].calendar_external_id, school.url,
    'der Auftrag nennt einen Kalender, in dem seine Adresse nicht liegt');
  assert.equal(pending[0].caldav_account_id, accountId);

  dav.allowAll();
  await caldavSync.sync();
  assert.equal(dav.getObject(school.url, `${uid}.ics`), null, 'der Termin liegt weiter in zwei Kalendern');
  assert.ok(dav.getObject(dest.url, `${uid}.ics`));
  assert.equal(eventTombstones().length, 0);
  assert.equal(eventRows(uid).length, 1);
  assert.equal(event(id).calendar_ref_id, dest.refId);
});

test('Umzug, die Quelle lehnt das Löschen ab, und für sie steht schon ein Auftrag mit veralteter Adresse: er zählt die Absage und räumt später das richtige Objekt ab', async () => {
  reset();
  const uid = 'move-10@test';
  const { source, dest, id } = pendingMoveInOrder(uid, true);
  // Ein älterer Auftrag für dieselbe UID in der Quelle; er behält Konto und
  // Adresse (ein Auftrag je UID und Kalender).
  db.prepare(`
    INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url, caldav_account_id)
    VALUES ('caldav', ?, ?, ?, ?)
  `).run(source.url, uid, `${source.url}renamed-long-ago.ics`, accountId);

  refuseSourceDelete();
  await caldavSync.flushOutbound();
  // Der ältere Auftrag wurde selbst abgelehnt (ein Versuch), die Absage des
  // Umzugs zählt als zweiter. Er behält seine Adresse; der Lauf findet das
  // Objekt über seinen Abruf.
  assert.equal(event(id).calendar_ref_id, dest.refId);
  const pending = eventTombstones();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].calendar_external_id, source.url);
  assert.equal(pending[0].object_url, `${source.url}renamed-long-ago.ics`);
  assert.equal(pending[0].caldav_account_id, accountId);
  assert.equal(pending[0].attempts, 2, 'die Absage des Umzugs wurde am bestehenden Auftrag nicht gezählt');

  dav.allowAll();
  await caldavSync.sync();
  assert.equal(dav.getObject(source.url, `${uid}.ics`), null, 'der Termin liegt weiter in beiden Kalendern');
  assert.ok(dav.getObject(dest.url, `${uid}.ics`));
  assert.equal(eventTombstones().length, 0);
  assert.equal(eventRows(uid).length, 1);
});

test('Umzug, die Quelle lehnt das Löschen fünfmal ab: danach wird aufgegeben, der Termin liegt in beiden Kalendern bei einer Zeile, und nichts hängt', async () => {
  reset();
  const uid = 'move-11@test';
  const { source, dest, id } = pendingMoveInOrder(uid, true);
  refuseSourceDelete();

  await caldavSync.flushOutbound();
  assert.equal(eventTombstones()[0]?.attempts, 1);
  for (const attempts of [2, 3, 4]) {
    await caldavSync.sync();
    assert.deepEqual(eventTombstones().map((t) => t.attempts), [attempts]);
    assert.equal(eventRows(uid).length, 1);
    assert.equal(event(id).calendar_ref_id, dest.refId);
  }

  // Die fünfte Absage: aufgegeben.
  await caldavSync.sync();
  assert.equal(eventTombstones().length, 0, 'der Auftrag wird nach der fünften Absage weiter versucht');
  assert.ok(dav.getObject(source.url, `${uid}.ics`));
  assert.ok(dav.getObject(dest.url, `${uid}.ics`));

  const deletesBefore = dav.seen('DELETE').length;
  await caldavSync.sync();
  await caldavSync.sync();
  assert.equal(dav.seen('DELETE').length, deletesBefore, 'nach dem Aufgeben wird weiter gelöscht');
  assert.equal(eventRows(uid).length, 1, 'aus den zwei Objekten wurden zwei Zeilen');
  const row = event(id);
  assert.ok(row);
  assert.equal(row.outbound_move_to, null);
  assert.equal(row.outbound_dirty, 0);
  assert.equal(eventTombstones().length, 0);
});

for (const status of [403, 503]) {
  test(`Umzug, die Quelle lehnt das Löschen kontoweit ab (${status}): kein Versuch wird verbraucht, auch nicht beim Vormerken (#1863)`, async () => {
    reset();
    const uid = `move-12-${status}@test`;
    const { source, dest, id } = pendingMoveInOrder(uid, true);
    refuseSourceDelete(status);

    // Die Absage beim Umzug selbst legt den Auftrag an (`queueRefusedDeletion`).
    await caldavSync.flushOutbound();
    assertRefused('DELETE', status);
    assert.equal(event(id).calendar_ref_id, dest.refId);
    assert.deepEqual(eventTombstones().map((t) => t.attempts), [0],
      'die kontoweite Absage beim Umzug hat einen Versuch verbraucht');
    assert.match(eventTombstones()[0].last_error, new RegExp(`HTTP ${status}`));

    // Danach der wartende Auftrag, über die Fünf hinaus.
    for (let i = 0; i < MAX_OUTBOUND_ATTEMPTS; i++) await caldavSync.sync();
    assert.equal(dav.seen('DELETE').length, MAX_OUTBOUND_ATTEMPTS + 1, 'nicht jeder Lauf hat das Löschen gesendet');
    assert.deepEqual(eventTombstones().map((t) => t.attempts), [0],
      'eine kontoweite Absage hat einen Versuch des Auftrags verbraucht');
    assert.equal(eventRows(uid).length, 1);

    dav.allowAll();
    await caldavSync.sync();
    assert.equal(dav.getObject(source.url, `${uid}.ics`), null, 'der Termin liegt weiter in beiden Kalendern');
    assert.ok(dav.getObject(dest.url, `${uid}.ics`));
    assert.equal(eventTombstones().length, 0);
    assert.equal(eventRows(uid).length, 1);
  });
}

test('Umzug, die Quelle lehnt das Löschen ab, dann zurück in die Quelle: der Termin bleibt dort stehen', async () => {
  reset();
  const uid = 'move-8@test';
  const { source, dest, id } = pendingMoveInOrder(uid, true);

  refuseSourceDelete();
  await caldavSync.flushOutbound();
  assert.equal(event(id).calendar_ref_id, dest.refId);

  // Zurück in den alten Kalender, während dessen Objekt noch auf sein Löschen
  // wartet. Der Umzug trifft dort auf die eigene, stehengebliebene Kopie (412)
  // und übernimmt sie - das wartende Löschen darf sie danach nicht mehr treffen.
  db.prepare(`
    UPDATE calendar_events SET outbound_move_to = ?, target_caldav_calendar_url = ? WHERE id = ?
  `).run(source.url, source.url, id);
  await caldavSync.flushOutbound();
  assert.equal(event(id).calendar_ref_id, source.refId, 'der Rückweg ist nicht gelaufen');
  assert.equal(dav.getObject(dest.url, `${uid}.ics`), null);

  dav.allowAll();
  await caldavSync.sync();
  await caldavSync.sync();
  assert.ok(dav.getObject(source.url, `${uid}.ics`), 'das wartende Löschen hat den zurückgezogenen Termin vom Server genommen');
  assert.ok(event(id), 'der zurückgezogene Termin ist hier verschwunden');
  assert.equal(event(id).calendar_ref_id, source.refId);
  assert.equal(eventTombstones().length, 0);
});

// ── Das wartende Löschen gilt dem Objekt, wie es beim Umzug war (#1883) ─────────
//
// Der Auftrag aus einem abgelehnten Umzug wartet über Läufe hinweg. Liegt der
// Termin in der Zwischenzeit wieder im alten Kalender - auf einem anderen Gerät
// zurückgeschoben -, löschte der nächste Versuch ihn dort trotzdem: der Lauf
// schickte den ETag aus seinem EIGENEN Abruf mit, der Sofortversuch gar keinen.
// Der Termin war danach in beiden Kalendern fort.

/** Umzug mit abgelehntem Löschen der Quelle; danach lässt der Server wieder alles zu. */
async function refusedMove(uid) {
  const { source, dest, id } = pendingMoveInOrder(uid, true);
  refuseSourceDelete();
  await caldavSync.flushOutbound();
  assertRefused('DELETE', 409);
  assert.equal(event(id).calendar_ref_id, dest.refId);
  assert.equal(eventTombstones().length, 1, 'das abgelehnte Löschen ist nicht vorgemerkt - der Fall ist nicht nachgestellt');
  dav.allowAll();
  return { source, dest, id };
}

/** Ein anderes Gerät nimmt die Kopie aus dem Ziel. */
const removeElsewhere = (collectionUrl, filename) => fetch(`${collectionUrl}${filename}`, { method: 'DELETE' });

test('Wartendes Löschen, der Termin wurde woanders zurück in den alten Kalender gelegt: der Lauf löscht ihn dort nicht', async () => {
  reset();
  const uid = 'back-1@test';
  const { source, dest, id } = await refusedMove(uid);

  // Anderes Gerät: zurück in den alten Kalender (dieselbe Adresse, neuer
  // Stand), die Kopie im Ziel entfernt.
  dav.putObject(source.url, `${uid}.ics`, vevent(uid, 'Woanders zurückgelegt'));
  await removeElsewhere(dest.url, `${uid}.ics`);
  dav.requests.length = 0;

  await caldavSync.sync();
  assert.ok(dav.getObject(source.url, `${uid}.ics`),
    'das wartende Löschen hat den zurückgelegten Termin vom Server genommen - er ist in beiden Kalendern fort');
  // Der Abruf hat den anderen Stand gesehen: dafür braucht es keine Anfrage.
  assert.equal(dav.seen('DELETE').length, 0, 'der Lauf hat ein DELETE geschickt, obwohl sein Abruf den anderen Stand kannte');
  assert.equal(eventTombstones().length, 0, 'der Auftrag gilt einem Stand, den es nicht mehr gibt, und wartet weiter');

  // Die Zeile folgt dem Termin in den alten Kalender, im selben Lauf.
  assert.equal(eventRows(uid).length, 1);
  const row = event(id);
  assert.ok(row, 'die Zeile ist weg');
  assert.equal(row.calendar_ref_id, source.refId, 'die Zeile ist dem Termin nicht in den alten Kalender gefolgt');
  assert.equal(row.title, 'Woanders zurückgelegt');

  // Und es bleibt dabei.
  await caldavSync.sync();
  assert.ok(dav.getObject(source.url, `${uid}.ics`));
  assert.equal(eventRows(uid).length, 1);
  assert.equal(event(id).calendar_ref_id, source.refId);
});

test('Wartendes Löschen, der Termin wurde woanders zurückgelegt: auch der Sofortversuch löscht ihn dort nicht', async () => {
  reset();
  const uid = 'back-2@test';
  const { source, dest, id } = await refusedMove(uid);

  dav.putObject(source.url, `${uid}.ics`, vevent(uid, 'Woanders zurückgelegt'));
  await removeElsewhere(dest.url, `${uid}.ics`);
  dav.requests.length = 0;

  // Der Sofortversuch hat keinen Abruf: er kennt nur, was am Auftrag steht.
  await caldavSync.flushOutbound();
  const deletes = dav.seen('DELETE').filter((r) => r.path.startsWith('/cal/family/'));
  assert.equal(deletes.length, 1, 'der Sofortversuch hat den Auftrag nicht angefasst - der Fall misst nichts');
  assert.ok(deletes[0].headers['if-match'], 'das DELETE ging ohne Vorbedingung hinaus');
  assert.ok(dav.getObject(source.url, `${uid}.ics`),
    'der Sofortversuch hat den zurückgelegten Termin vom Server genommen');
  assert.equal(eventTombstones().length, 0, 'eine verfehlte Vorbedingung wird wiederholt statt verworfen');

  await caldavSync.sync();
  assert.ok(dav.getObject(source.url, `${uid}.ics`));
  assert.equal(eventRows(uid).length, 1);
  assert.equal(event(id).calendar_ref_id, source.refId);
});

test('Wartendes Löschen, der Termin liegt im alten Kalender jetzt unter einer anderen Adresse: er bleibt stehen', async () => {
  reset();
  const uid = 'back-3@test';
  const { source, dest, id } = await refusedMove(uid);

  // Anderes Gerät: das alte Objekt ist fort, der Termin liegt unter neuem
  // Namen wieder dort.
  await removeElsewhere(source.url, `${uid}.ics`);
  dav.putObject(source.url, 'put-back.ics', vevent(uid, 'Unter neuem Namen'));
  await removeElsewhere(dest.url, `${uid}.ics`);

  await caldavSync.sync();
  await caldavSync.sync();
  assert.ok(dav.getObject(source.url, 'put-back.ics'),
    'das wartende Löschen hat ein anderes Objekt derselben UID getroffen');
  assert.equal(eventTombstones().length, 0);
  assert.equal(eventRows(uid).length, 1);
  assert.equal(event(id).calendar_ref_id, source.refId);
  assert.equal(event(id).external_object_url, `${source.url}put-back.ics`);
});

test('Wartendes Löschen, der Termin wird zwischen Abruf und DELETE zurückgelegt: die Vorbedingung hält, der Auftrag fällt', async () => {
  reset();
  const uid = 'back-4@test';
  const { source, dest, id } = await refusedMove(uid);

  // Das andere Gerät schreibt in dem Moment, in dem das DELETE ankommt - nach
  // dem Abruf dieses Laufs. Die Regel lehnt nichts ab, sie ist nur der Haken.
  let armed = true;
  dav.refuse({
    method: 'DELETE', status: 500,
    when: (req) => {
      if (armed && req.path.startsWith('/cal/family/')) {
        armed = false;
        dav.putObject(source.url, `${uid}.ics`, vevent(uid, 'Im letzten Moment zurückgelegt'));
      }
      return false;
    },
  });
  await caldavSync.sync();
  assert.equal(armed, false, 'der Lauf hat kein DELETE an die Quelle geschickt - der Fall misst nichts');
  assert.ok(dav.getObject(source.url, `${uid}.ics`), 'das DELETE ging ohne wirksame Vorbedingung durch');
  assert.equal(eventTombstones().length, 0, 'eine verfehlte Vorbedingung wird wiederholt, und der nächste Lauf löscht mit frischem ETag');

  await removeElsewhere(dest.url, `${uid}.ics`);
  await caldavSync.sync();
  await caldavSync.sync();
  assert.ok(dav.getObject(source.url, `${uid}.ics`), 'ein späterer Lauf hat den zurückgelegten Termin doch gelöscht');
  assert.equal(eventRows(uid).length, 1);
  assert.equal(event(id).calendar_ref_id, source.refId);
});

test('Wartendes Löschen, die Quelle ist unverändert: der Auftrag trägt ihren ETag und räumt sie mit ihm als Vorbedingung ab', async () => {
  reset();
  const uid = 'back-5@test';
  const { source, dest } = pendingMoveInOrder(uid, true);
  const etagThen = dav.getObject(source.url, `${uid}.ics`).etag;
  refuseSourceDelete();
  await caldavSync.flushOutbound();
  assert.equal(eventTombstones()[0]?.etag, etagThen, 'der Auftrag kennt den Stand nicht, für den er vorgemerkt wurde');
  dav.allowAll();
  dav.requests.length = 0;

  await caldavSync.sync();
  const deletes = dav.seen('DELETE').filter((r) => r.path.startsWith('/cal/family/'));
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].headers['if-match'], etagThen);
  assert.equal(dav.getObject(source.url, `${uid}.ics`), null, 'die unveränderte Quelle bleibt stehen');
  assert.ok(dav.getObject(dest.url, `${uid}.ics`));
  assert.equal(eventTombstones().length, 0);
});

test('Wartendes Löschen ohne bekannten Stand (Löschen in Yuvomi): gilt weiter dem Termin, wie er dann ist', async () => {
  reset();
  const uid = 'back-6@test';
  const cal = calendar('family', 'Familie');
  mirroredEvent(cal, uid, 'Wird gelöscht');
  // Der Auftrag der Löschroute: der Nutzer will den Termin fort haben, gleich
  // in welchem Stand. Er trägt keinen ETag.
  db.prepare('DELETE FROM calendar_events WHERE external_calendar_id = ?').run(uid);
  db.prepare(`
    INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url, caldav_account_id)
    VALUES ('caldav', ?, ?, ?, ?)
  `).run(cal.url, uid, `${cal.url}${uid}.ics`, accountId);
  dav.putObject(cal.url, `${uid}.ics`, vevent(uid, 'Woanders bearbeitet'));

  await caldavSync.sync();
  assert.equal(dav.getObject(cal.url, `${uid}.ics`), null, 'eine Löschung des Nutzers hängt jetzt am Stand des Objekts');
  assert.equal(eventTombstones().length, 0);
  assert.equal(eventRows(uid).length, 0);
});

test('Wartendes Löschen, dann löscht der Nutzer den Termin: auch der inzwischen geänderte Rest im alten Kalender geht mit', async () => {
  reset();
  const uid = 'back-8@test';
  const { source, dest, id } = await refusedMove(uid);
  assert.ok(eventTombstones()[0].etag, 'der Auftrag für die Quelle ist nicht bedingt - der Fall misst nichts');

  // Der Rest im alten Kalender wird woanders bearbeitet; danach löscht der
  // Nutzer den Termin in Yuvomi. Die Löschroute merkt für den Kalender der
  // Zeile vor (das Ziel) - wie sie es tut: vormerken, dann die Zeile löschen.
  dav.putObject(source.url, `${uid}.ics`, vevent(uid, 'Woanders bearbeitet'));
  assert.equal(queueEventDeletion(event(id)), true);
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);

  await caldavSync.sync();
  await caldavSync.sync();
  assert.equal(dav.getObject(dest.url, `${uid}.ics`), null);
  assert.equal(dav.getObject(source.url, `${uid}.ics`), null,
    'der Rest im alten Kalender blieb stehen: der gelöschte Termin kommt von dort zurück');
  assert.equal(eventRows(uid).length, 0, 'der vom Nutzer gelöschte Termin ist wieder da');
  assert.equal(eventTombstones().length, 0);
});

test('Umzug, die Quelle lehnt das Löschen mit 412 ab: ihr Stand ist schon überholt, der Auftrag bleibt ohne Bedingung', async () => {
  reset();
  const uid = 'back-7@test';
  const { source, dest } = pendingMoveInOrder(uid, true);
  dav.refuse({ method: 'DELETE', status: 412, when: (req) => req.path.startsWith('/cal/family/') });
  await caldavSync.flushOutbound();
  assertRefused('DELETE', 412);
  const pending = eventTombstones();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].etag, null, 'der Auftrag wartet auf einen Stand, den es schon beim Vormerken nicht mehr gab');

  // Er läuft wie vor #1883 und räumt die Quelle ab, statt sofort zu fallen
  // und den Termin für immer in beiden Kalendern zu lassen.
  dav.allowAll();
  await caldavSync.sync();
  assert.equal(dav.getObject(source.url, `${uid}.ics`), null);
  assert.ok(dav.getObject(dest.url, `${uid}.ics`));
  assert.equal(eventTombstones().length, 0);
});

test('Löschauftrag: eine Löschung ohne Stand hebt die Bedingung eines wartenden Auftrags auf, umgekehrt entsteht keine', () => {
  reset();
  const cal = 'https://dav.example/cal/family/';
  const target = { source: 'caldav', calendarExternalId: cal, eventExternalId: 'cond-1@test', accountId };

  // Bedingt vorgemerkt, dann löscht der Nutzer denselben Termin dort.
  queueDeletion({ ...target, objectUrl: `${cal}a.ics`, etag: '"then"' });
  assert.equal(eventTombstones()[0].etag, '"then"');
  queueDeletion({ ...target, objectUrl: `${cal}a.ics` });
  let pending = eventTombstones();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].etag, null, 'die Löschung des Nutzers hängt am Stand eines früheren Umzugs');

  // Ein bestehender Auftrag ohne Stand bekommt nachträglich keinen: seine
  // Adresse bleibt, und der ETag eines anderen Objekts passte nicht zu ihr.
  queueDeletion({ ...target, objectUrl: `${cal}b.ics`, etag: '"later"' });
  pending = eventTombstones();
  assert.equal(pending[0].object_url, `${cal}a.ics`);
  assert.equal(pending[0].etag, null, 'Adresse des einen Auftrags, Stand des anderen');

  // Ein ETag ohne Adresse bedingt nichts.
  queueDeletion({ ...target, eventExternalId: 'cond-2@test', etag: '"alone"' });
  assert.equal(eventTombstones().find((t) => t.event_external_id === 'cond-2@test').etag, null);
});

test('Apple-Kalender: ein bedingter Löschauftrag lässt ein Objekt in anderem Stand stehen', async () => {
  reset();
  const url = dav.addCollection('icloud', { name: 'iCloud' });
  dav.putObject(url, 'neighbour.ics', vevent('apple-neighbour@test', 'Nachbar'));
  const uid = 'apple-back@test';
  const then = dav.putObject(url, `${uid}.ics`, vevent(uid, 'Beim Umzug'));
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  queueDeletion({ source: 'apple', calendarExternalId: url, eventExternalId: uid, objectUrl: then.url, etag: then.etag });
  assert.equal(eventTombstones()[0]?.etag, then.etag);
  dav.putObject(url, `${uid}.ics`, vevent(uid, 'Woanders zurückgelegt'));

  try {
    await appleCalendar.sync();
    assert.ok(dav.getObject(url, `${uid}.ics`), 'der bedingte Auftrag hat ein Objekt in anderem Stand gelöscht');
    assert.equal(eventTombstones().length, 0);
  } finally {
    appleCalendar.clearCredentials();
  }
});

test('Umzug, die Quelle ist schon weg (404): der Umzug ist vollzogen, nichts wird vorgemerkt', async () => {
  reset();
  const uid = 'move-9@test';
  const { source, dest, id } = pendingMoveInOrder(uid, true);

  dav.refuse({ method: 'DELETE', status: 404, when: (req) => req.path.startsWith('/cal/family/') });
  await caldavSync.flushOutbound();
  assertRefused('DELETE', 404);

  assert.equal(event(id).calendar_ref_id, dest.refId);
  assert.equal(eventTombstones().length, 0, 'ein 404 der Quelle wurde als offenes Löschen vorgemerkt');
});

// ── Kontoweite Absagen zählen nicht gegen den Eintrag (#1863) ──────────────────
//
// Ein Auftrag wird nach MAX_OUTBOUND_ATTEMPTS Absagen aufgegeben, und der
// nächste Abruf holt den Stand des Servers zurück. Zählen darf dabei nur, was
// über DIESEN Eintrag etwas sagt. Antwortet der Server auf alles mit 401
// (Passwort abgelaufen), 429 (Ratenlimit), 503 oder gar nicht, trifft jeder
// Sofortversuch - einer je Bearbeitung - jeden wartenden Auftrag. Nach fünf
// Bearbeitungen war das gelöschte Objekt wieder da und die Änderung verloren.
//
// Nachgestellt mit dem Sofortversuch, wie er hinter jeder Schreibroute läuft:
// er sendet ein Löschen ohne Abruf und eine Änderung nach einem Abruf des
// Objekts; `assertSent` prüft, dass die Anfrage jedes Mal am Server ankam.
// Löschen und Ändern laufen getrennt: nach einer kontoweiten Absage geht in
// diesem Durchgang nichts mehr an das Konto (siehe "Stoppsignal" unten).

const ACCOUNT_WIDE_REFUSALS = [
  ['401', { status: 401 }],
  ['403', { status: 403 }],
  ['429', { status: 429 }],
  ['503', { status: 503 }],
  ['Netzfehler', { drop: true }],
];
// 423 (gesperrt) steht für jeden Status, den keiner der beiden Listen kennt:
// er hängt am Eintrag, sonst wartete ein dauerhaft gesperrter für immer.
const ENTRY_REFUSALS = [409, 422, 423];

/** Ein wartendes Löschen im Kalender `cal`. */
function pendingEventDeletion(cal, uid = 'gone@test') {
  const { url } = dav.putObject(cal.url, `${uid}.ics`, vevent(uid, 'Gelöscht'));
  db.prepare(`
    INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url, caldav_account_id)
    VALUES ('caldav', ?, ?, ?, ?)
  `).run(cal.url, uid, url, accountId);
  return url;
}

/** Eine wartende Änderung eines gespiegelten Termins in `cal`. */
function pendingEventChange(cal, uid = 'evt-1@test') {
  const { id } = mirroredEvent(cal, uid, 'Alter Titel');
  db.prepare("UPDATE calendar_events SET title = 'Neuer Titel', outbound_dirty = 1 WHERE id = ?").run(id);
  return id;
}

function pendingTaskDeletion(list, uid = 'gone@test') {
  const { url } = dav.putObject(list, `${uid}.ics`, vtodo(uid, 'Gelöscht'));
  db.prepare(`
    INSERT INTO caldav_todo_pending_deletions (account_id, module, uid, object_url)
    VALUES (?, 'tasks', ?, ?)
  `).run(accountId, uid, url);
  return url;
}

function pendingTaskChange(list, uid = 'todo-1@test') {
  const { id } = mirroredTask(list, uid, 'Alter Titel');
  db.prepare("UPDATE tasks SET title = 'Neuer Titel', outbound_dirty = 1 WHERE id = ?").run(id);
  return id;
}

/** So viele Anfragen dieser Methode kamen am Server an - sonst belegt der Rest nichts. */
function assertSent(method, rounds) {
  assert.equal(dav.seen(method).length, rounds, `nicht jeder Sofortversuch hat ${method} gesendet`);
}

const writesSent = () => dav.seen('DELETE').length + dav.seen('PUT').length;

function refuseWrites(refusal) {
  dav.allowAll();
  dav.refuse({ method: 'DELETE', ...refusal });
  dav.refuse({ method: 'PUT', ...refusal });
}

for (const [label, refusal] of ACCOUNT_WIDE_REFUSALS) {
  test(`Termin löschen, ${MAX_OUTBOUND_ATTEMPTS + 1} kontoweite Absagen (${label}) hintereinander: der Auftrag bleibt`, async () => {
    reset();
    const cal = calendar();
    pendingEventDeletion(cal);

    refuseWrites(refusal);
    for (let i = 0; i < MAX_OUTBOUND_ATTEMPTS; i++) await caldavSync.flushOutbound();
    assertSent('DELETE', MAX_OUTBOUND_ATTEMPTS);
    await caldavSync.flushOutbound();

    assert.equal(eventTombstones().length, 1, 'das Löschen wurde nach kontoweiten Absagen aufgegeben');
    assert.equal(eventTombstones()[0].attempts, 0, 'eine kontoweite Absage hat einen Versuch des Eintrags verbraucht');
    assertSent('DELETE', MAX_OUTBOUND_ATTEMPTS + 1);

    // Der Lauf, in dem der Schaden sichtbar wurde: der Server nimmt wieder an.
    dav.allowAll();
    await caldavSync.sync();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE external_calendar_id = 'gone@test'").get().n, 0,
      'der gelöschte Termin ist zurück'
    );
    assert.equal(dav.getObject(cal.url, 'gone@test.ics'), null, 'der Termin liegt weiter auf dem Server');
    assert.equal(eventTombstones().length, 0);
  });

  test(`Termin ändern, ${MAX_OUTBOUND_ATTEMPTS + 1} kontoweite Absagen (${label}) hintereinander: die Änderung bleibt`, async () => {
    reset();
    const cal = calendar();
    const id = pendingEventChange(cal);

    refuseWrites(refusal);
    for (let i = 0; i < MAX_OUTBOUND_ATTEMPTS; i++) await caldavSync.flushOutbound();
    assertSent('PUT', MAX_OUTBOUND_ATTEMPTS);
    await caldavSync.flushOutbound();

    let row = event(id);
    assert.equal(row.outbound_dirty, 1, 'die Änderung wurde nach kontoweiten Absagen aufgegeben');
    assert.equal(row.outbound_attempts, 0, 'eine kontoweite Absage hat einen Versuch des Eintrags verbraucht');
    assertSent('PUT', MAX_OUTBOUND_ATTEMPTS + 1);

    dav.allowAll();
    await caldavSync.sync();
    row = event(id);
    assert.equal(row.title, 'Neuer Titel', 'der Abruf hat die lokale Bearbeitung überschrieben');
    assert.equal(row.outbound_dirty, 0);
    assert.match(dav.getObject(cal.url, 'evt-1@test.ics').data, /SUMMARY:Neuer Titel/);
  });

  test(`Aufgabe löschen, ${MAX_OUTBOUND_ATTEMPTS + 1} kontoweite Absagen (${label}) hintereinander: der Auftrag bleibt`, async () => {
    reset();
    const list = taskList();
    pendingTaskDeletion(list);

    refuseWrites(refusal);
    for (let i = 0; i < MAX_OUTBOUND_ATTEMPTS; i++) await todoOutbound.flushOutbound();
    assertSent('DELETE', MAX_OUTBOUND_ATTEMPTS);
    await todoOutbound.flushOutbound();

    assert.equal(todoTombstones().length, 1, 'das Löschen wurde nach kontoweiten Absagen aufgegeben');
    assert.equal(todoTombstones()[0].attempts, 0, 'eine kontoweite Absage hat einen Versuch des Eintrags verbraucht');
    assertSent('DELETE', MAX_OUTBOUND_ATTEMPTS + 1);

    dav.allowAll();
    await remindersSync.sync();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE external_uid = 'gone@test'").get().n, 0,
      'die gelöschte Aufgabe ist zurück'
    );
    assert.equal(dav.getObject(list, 'gone@test.ics'), null, 'die Aufgabe liegt weiter auf dem Server');
    assert.equal(todoTombstones().length, 0);
  });

  test(`Aufgabe ändern, ${MAX_OUTBOUND_ATTEMPTS + 1} kontoweite Absagen (${label}) hintereinander: die Änderung bleibt`, async () => {
    reset();
    const list = taskList();
    const id = pendingTaskChange(list);

    refuseWrites(refusal);
    for (let i = 0; i < MAX_OUTBOUND_ATTEMPTS; i++) await todoOutbound.flushOutbound();
    assertSent('PUT', MAX_OUTBOUND_ATTEMPTS);
    await todoOutbound.flushOutbound();

    let row = task(id);
    assert.equal(row.outbound_dirty, 1, 'die Änderung wurde nach kontoweiten Absagen aufgegeben');
    assert.equal(row.outbound_attempts, 0, 'eine kontoweite Absage hat einen Versuch des Eintrags verbraucht');
    assertSent('PUT', MAX_OUTBOUND_ATTEMPTS + 1);

    dav.allowAll();
    await remindersSync.sync();
    row = task(id);
    assert.equal(row.title, 'Neuer Titel', 'der Abruf hat die lokale Bearbeitung überschrieben');
    assert.equal(row.outbound_dirty, 0);
    assert.match(dav.getObject(list, 'todo-1@test.ics').data, /SUMMARY:Neuer Titel/);
  });
}

for (const status of ENTRY_REFUSALS) {
  test(`Termine, Absage am Eintrag selbst (${status}): die fünfte beendet die Versuche`, async () => {
    reset();
    const cal = calendar();
    pendingEventDeletion(cal);
    const id = pendingEventChange(cal);

    refuseWrites({ status });
    for (let i = 1; i < MAX_OUTBOUND_ATTEMPTS; i++) {
      await caldavSync.flushOutbound();
      assert.deepEqual(eventTombstones().map((t) => t.attempts), [i]);
      assert.equal(event(id).outbound_attempts, i);
      assert.equal(event(id).outbound_dirty, 1);
    }
    await caldavSync.flushOutbound();
    assertSent('DELETE', MAX_OUTBOUND_ATTEMPTS);
    assertSent('PUT', MAX_OUTBOUND_ATTEMPTS);
    assert.equal(eventTombstones().length, 0, 'das Löschen wird nach der fünften Absage am Eintrag weiter versucht');
    assert.equal(event(id).outbound_dirty, 0, 'die Änderung wird nach der fünften Absage am Eintrag weiter versucht');

    await caldavSync.flushOutbound();
    assert.equal(writesSent(), 2 * MAX_OUTBOUND_ATTEMPTS);
  });

  test(`Aufgaben, Absage am Eintrag selbst (${status}): die fünfte beendet die Versuche`, async () => {
    reset();
    const list = taskList();
    pendingTaskDeletion(list);
    const id = pendingTaskChange(list);

    refuseWrites({ status });
    for (let i = 1; i < MAX_OUTBOUND_ATTEMPTS; i++) {
      await todoOutbound.flushOutbound();
      assert.deepEqual(todoTombstones().map((t) => t.attempts), [i]);
      assert.equal(task(id).outbound_attempts, i);
      assert.equal(task(id).outbound_dirty, 1);
    }
    await todoOutbound.flushOutbound();
    assertSent('DELETE', MAX_OUTBOUND_ATTEMPTS);
    assertSent('PUT', MAX_OUTBOUND_ATTEMPTS);
    assert.equal(todoTombstones().length, 0, 'das Löschen wird nach der fünften Absage am Eintrag weiter versucht');
    assert.equal(task(id).outbound_dirty, 0, 'die Änderung wird nach der fünften Absage am Eintrag weiter versucht');

    await todoOutbound.flushOutbound();
    assert.equal(writesSent(), 2 * MAX_OUTBOUND_ATTEMPTS);
  });
}

test('Kontoweite Absagen zwischen Absagen am Eintrag schieben das Aufgeben nicht vor', async () => {
  reset();
  pendingEventDeletion(calendar());

  for (let i = 0; i < MAX_OUTBOUND_ATTEMPTS - 1; i++) {
    refuseWrites({ status: 422 });
    await caldavSync.flushOutbound();
    refuseWrites({ status: 503 });
    await caldavSync.flushOutbound();
  }
  assert.deepEqual(eventTombstones().map((t) => t.attempts), [MAX_OUTBOUND_ATTEMPTS - 1],
    'kontoweite Absagen haben Versuche des Eintrags verbraucht');
  assert.match(eventTombstones()[0].last_error, /HTTP 503/, 'die letzte Absage steht nicht am Auftrag');
  assertSent('DELETE', 2 * (MAX_OUTBOUND_ATTEMPTS - 1));

  refuseWrites({ status: 422 });
  await caldavSync.flushOutbound();
  assert.equal(eventTombstones().length, 0);
});

// Stoppsignal: weil eine kontoweite Absage keinen Versuch mehr kostet, liefe
// ohne Halt jeder wartende Eintrag bei JEDEM Durchgang in dieselbe Absage -
// eine Anfrage je Eintrag in einen Server, der gerade "zu viele Anfragen"
// gesagt hat. Nach der ersten kontoweiten Absage geht in diesem Durchgang
// nichts mehr an das Konto, weder Löschen noch Ändern; die Aufträge bleiben.

test('Stoppsignal, Termine: drei Löschungen und zwei Änderungen, die erste Antwort ist 429 - genau eine Anfrage', async () => {
  reset();
  const cal = calendar();
  for (const uid of ['gone-1@test', 'gone-2@test', 'gone-3@test']) pendingEventDeletion(cal, uid);
  const ids = ['evt-1@test', 'evt-2@test'].map((uid) => pendingEventChange(cal, uid));

  refuseWrites({ status: 429 });
  await caldavSync.flushOutbound();
  assert.equal(writesSent(), 1, 'nach der kontoweiten Absage gingen weitere Anfragen an das Konto');
  assert.deepEqual(eventTombstones().map((t) => t.attempts), [0, 0, 0]);
  assert.deepEqual(ids.map((id) => [event(id).outbound_dirty, event(id).outbound_attempts]), [[1, 0], [1, 0]]);

  // Der nächste Durchgang fängt neu an: alles geht hinaus.
  dav.allowAll();
  await caldavSync.flushOutbound();
  assert.equal(eventTombstones().length, 0);
  assert.deepEqual(ids.map((id) => event(id).outbound_dirty), [0, 0]);
});

test('Stoppsignal, Aufgaben: drei Löschungen und zwei Änderungen, die erste Antwort ist 429 - genau eine Anfrage', async () => {
  reset();
  const list = taskList();
  for (const uid of ['gone-1@test', 'gone-2@test', 'gone-3@test']) pendingTaskDeletion(list, uid);
  const ids = ['todo-1@test', 'todo-2@test'].map((uid) => pendingTaskChange(list, uid));

  refuseWrites({ status: 429 });
  await todoOutbound.flushOutbound();
  assert.equal(writesSent(), 1, 'nach der kontoweiten Absage gingen weitere Anfragen an das Konto');
  assert.deepEqual(todoTombstones().map((t) => t.attempts), [0, 0, 0]);
  assert.deepEqual(ids.map((id) => [task(id).outbound_dirty, task(id).outbound_attempts]), [[1, 0], [1, 0]]);

  dav.allowAll();
  await todoOutbound.flushOutbound();
  assert.equal(todoTombstones().length, 0);
  assert.deepEqual(ids.map((id) => task(id).outbound_dirty), [0, 0]);
});

test('Stoppsignal, Sync-Lauf: auch der volle Lauf sendet nach einer kontoweiten Absage nichts mehr an das Konto', async () => {
  reset();
  const cal = calendar();
  for (const uid of ['gone-1@test', 'gone-2@test']) pendingEventDeletion(cal, uid);
  pendingEventChange(cal);

  refuseWrites({ status: 503 });
  await caldavSync.sync();
  assert.equal(writesSent(), 1, 'nach der kontoweiten Absage gingen weitere Anfragen an das Konto');
  assert.deepEqual(eventTombstones().map((t) => t.attempts), [0, 0]);
});

test('Stoppsignal: ein 403 sperrt nur seinen Kalender, ein anderer Kalender desselben Kontos läuft weiter', async () => {
  reset();
  const shared = calendar('shared', 'Geteilt');
  const own    = calendar('family', 'Familie');
  pendingEventDeletion(shared, 'ro-1@test');
  pendingEventDeletion(shared, 'ro-2@test');
  pendingEventDeletion(own, 'mine@test');
  const id = pendingEventChange(own);

  dav.refuse({ method: 'DELETE', status: 403, when: (req) => req.path.startsWith('/cal/shared/') });
  dav.refuse({ method: 'PUT', status: 403, when: (req) => req.path.startsWith('/cal/shared/') });
  await caldavSync.flushOutbound();

  assert.equal(dav.seen('DELETE').filter((r) => r.path.startsWith('/cal/shared/')).length, 1,
    'nach dem 403 gingen weitere Anfragen an den geteilten Kalender');
  assert.equal(dav.getObject(own.url, 'mine@test.ics'), null, 'der 403 eines anderen Kalenders hielt das Löschen auf');
  assert.equal(event(id).outbound_dirty, 0, 'der 403 eines anderen Kalenders hielt die Änderung auf');
  assert.deepEqual(eventTombstones().map((t) => [t.event_external_id, t.attempts]), [['ro-1@test', 0], ['ro-2@test', 0]]);
});

// Stoppsignal über ALLE Phasen eines Durchgangs (#2135): das Signal galt nur
// Löschen und Ändern. Das Aufräumen alter Upload-Reste davor und die Uploads
// danach fragten es nicht und schickten demselben Konto, das gerade "429"
// oder "503" gesagt hatte, je Phase wieder etwas. Gezählt werden ALLE
// Anfragen nach der ersten kontoweiten Absage, nicht nur die schreibenden.

/** Anfragen, die nach der ersten Absage mit diesem Status noch ankamen. */
function requestsAfterFirst(status) {
  const first = dav.requests.findIndex((r) => r.status === status);
  assert.ok(first >= 0, `der Server hat nichts mit ${status} beantwortet - der Fall ist nicht nachgestellt`);
  return dav.requests.slice(first + 1).map((r) => `${r.method} ${r.path}`);
}

/** Der Rest eines nie bestätigten Uploads: Objekt auf dem Server, Notiz hier, Zeile fort. */
function leftoverUpload({ source = 'caldav', kind, uid, rowId, collectionUrl, data, expired = false }) {
  const { url } = dav.putObject(collectionUrl, `${uid}.ics`, data);
  db.prepare(`
    INSERT INTO caldav_upload_attempts (source, account_id, kind, row_id, collection_url, uid, object_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(source, source === 'caldav' ? accountId : null, kind, rowId, collectionUrl, uid, url,
    expired ? '2020-01-01T00:00:00Z' : new Date().toISOString());
  return { uid, url };
}

const leftoverEvent = (cal, rowId = 9001, opts = {}) => {
  const uid = eventUidFor(rowId);
  return leftoverUpload({ kind: 'event', uid, rowId, collectionUrl: cal.url, data: vevent(uid, 'Rest'), ...opts });
};
const leftoverTask = (listUrl, rowId = 9002) => {
  const uid = todoOutbound.todoUidFor('tasks', rowId);
  return leftoverUpload({ kind: 'task', uid, rowId, collectionUrl: listUrl, data: vtodo(uid, 'Rest') });
};
const uploadNotes = () => db.prepare('SELECT * FROM caldav_upload_attempts').all();

test('Stoppsignal über alle Phasen, Termine im Sync-Lauf: Rest, Löschen und Uploads - nach dem 429 keine Anfrage mehr (#2135)', async () => {
  reset();
  const cal = calendar();
  leftoverEvent(cal);
  pendingEventDeletion(cal);
  const ids = [localEvent(cal.url, 'Eins'), localEvent(cal.url, 'Zwei')];

  refuseWrites({ status: 429 });
  await caldavSync.sync();
  assert.deepEqual(requestsAfterFirst(429), [], 'nach der kontoweiten Absage gingen weitere Anfragen an das Konto');
  assert.equal(writesSent(), 1);
  assert.equal(uploadNotes().length, 1, 'die Notiz des Rests fiel');
  assert.deepEqual(eventTombstones().map((t) => t.attempts), [0]);
  for (const id of ids) assert.equal(event(id).external_source, 'local');

  // Der nächste Lauf fängt neu an: alles geht hinaus.
  dav.allowAll();
  await caldavSync.sync();
  assert.equal(uploadNotes().length, 0);
  assert.equal(eventTombstones().length, 0);
  for (const id of ids) assert.equal(event(id).external_source, 'caldav');
});

test('Stoppsignal über alle Phasen, iCloud: Rest, Löschen und Uploads - nach dem 503 keine Anfrage mehr (#2135)', async () => {
  reset();
  const url = dav.addCollection('icloud', { name: 'iCloud' });
  dav.putObject(url, 'neighbour.ics', vevent('apple-neighbour@test', 'Nachbar'));
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  try {
    leftoverUpload({ source: 'apple', kind: 'event', uid: eventUidFor(9001), rowId: 9001, collectionUrl: url, data: vevent(eventUidFor(9001), 'Rest') });
    const gone = dav.putObject(url, 'gone.ics', vevent('apple-gone@test', 'Gelöscht'));
    queueDeletion({ source: 'apple', calendarExternalId: url, eventExternalId: 'apple-gone@test', objectUrl: gone.url });
    for (const title of ['Eins', 'Zwei']) {
      db.prepare(`
        INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by, external_source)
        VALUES (?, '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, 'local')
      `).run(title);
    }

    refuseWrites({ status: 503 });
    await appleCalendar.sync();
    assert.deepEqual(requestsAfterFirst(503), [], 'nach der kontoweiten Absage gingen weitere Anfragen an das Konto');
    assert.equal(writesSent(), 1);
    assert.equal(uploadNotes().length, 1, 'die Notiz des Rests fiel');
    assert.equal(eventTombstones().length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE external_source = 'local'").get().n, 2);
  } finally {
    appleCalendar.clearCredentials();
  }
});

/** Aufgaben- und Einkaufsliste mit allem, was ein Durchgang schreiben kann. */
function todoWorkInEveryPhase() {
  const list = taskList();
  const { listId } = shoppingList();
  leftoverTask(list);
  pendingTaskDeletion(list);
  const tasks = [localTask(list, 'Eins'), localTask(list, 'Zwei')];
  db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(listId, 'Milch');
  return { list, tasks };
}

test('Stoppsignal über alle Phasen, Erinnerungen im Sync-Lauf: Löschen, Rest und Uploads - nach dem 429 keine Anfrage mehr (#2135)', async () => {
  reset();
  const { tasks } = todoWorkInEveryPhase();

  refuseWrites({ status: 429 });
  await remindersSync.sync();
  assert.deepEqual(requestsAfterFirst(429), [], 'nach der kontoweiten Absage gingen weitere Anfragen an das Konto');
  assert.equal(writesSent(), 1);
  assert.equal(uploadNotes().length, 1, 'die Notiz des Rests fiel');
  assert.deepEqual(todoTombstones().map((t) => t.attempts), [0]);
  for (const id of tasks) assert.equal(task(id).external_source, 'local');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shopping_items WHERE external_source = 'local'").get().n, 1);

  dav.allowAll();
  await remindersSync.sync();
  assert.equal(uploadNotes().length, 0);
  assert.equal(todoTombstones().length, 0);
  for (const id of tasks) assert.equal(task(id).external_source, 'caldav');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shopping_items WHERE external_source = 'local'").get().n, 0);
});

test('Stoppsignal über alle Phasen, Erinnerungen im Sofortversuch: nach dem ersten 503 keine Anfrage mehr, auch kein Abruf (#2135)', async () => {
  reset();
  const { tasks } = todoWorkInEveryPhase();

  refuseWrites({ status: 503 });
  await todoOutbound.flushOutbound();
  assert.deepEqual(requestsAfterFirst(503), [], 'nach der kontoweiten Absage gingen weitere Anfragen an das Konto');
  assert.equal(writesSent(), 1);
  assert.equal(uploadNotes().length, 1);
  assert.deepEqual(todoTombstones().map((t) => t.attempts), [0]);
  for (const id of tasks) assert.equal(task(id).external_source, 'local');

  dav.allowAll();
  await todoOutbound.flushOutbound();
  assert.equal(uploadNotes().length, 0);
  assert.equal(todoTombstones().length, 0);
  for (const id of tasks) assert.equal(task(id).external_source, 'caldav');
});

test('Stoppsignal über alle Phasen: ein 403 auf einer Liste lässt die Uploads in eine andere Liste desselben Kontos hinaus (#2135)', async () => {
  reset();
  const shared = taskList();
  const own = dav.addCollection('own', { name: 'Eigen', components: ['VTODO'] });
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'Eigen', 'tasks', 1)
  `).run(accountId, own);
  pendingTaskDeletion(shared);
  const id = localTask(own, 'Eigen');

  const onShared = (req) => req.path.startsWith(new URL(shared).pathname);
  dav.refuse({ method: 'DELETE', status: 403, when: onShared });
  dav.refuse({ method: 'PUT', status: 403, when: onShared });
  for (const run of [() => todoOutbound.flushOutbound(), () => remindersSync.sync()]) {
    await run();
    assert.equal(task(id).external_source, 'caldav', 'der 403 einer anderen Liste hielt den Upload auf');
  }
  assert.equal(todoTombstones().length, 1);
});

for (const status of [429, 503]) {
  test(`Rest eines Uploads nach der Frist, DELETE ${status}: die Notiz bleibt, das Objekt kommt nicht als Termin herein (#2135)`, async () => {
    reset();
    const cal = calendar();
    const { uid } = leftoverEvent(cal, 9001, { expired: true });

    dav.allowAll();
    dav.refuse({ method: 'DELETE', status });
    await caldavSync.sync();
    assertRefused('DELETE', status);
    assert.equal(uploadNotes().length, 1, 'eine kontoweite Absage hat die Notiz nach der Frist fallen lassen');

    // Der Lauf danach: die Notiz verdeckt das Objekt weiter.
    await caldavSync.sync();
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE external_calendar_id = ?').get(uid).n, 0,
      'der Rest kam als Termin herein'
    );

    dav.allowAll();
    await caldavSync.sync();
    assert.equal(uploadNotes().length, 0);
    assert.equal(dav.getObject(cal.url, `${uid}.ics`), null);
  });
}

// ── Gespiegelt heisst gesehen (#1839) ───────────────────────────────────────────
//
// Vor #1837 stempelte ein abgelehnter Upload die Zeile zum Spiegel eines
// Objekts, das es nie gab, und der naechste Prune loeschte sie als "anderswo
// entfernt". Entschieden am 9.10.: eine Zeile gilt erst als Spiegel, wenn ein
// Abruf ihr Objekt gesehen hat. Nachgestellt wird die Zeile, wie die alte
// Buchung sie hinterliess (Spiegel ohne Objekt, nie gesehen), und die Zeile,
// die ein Abruf gesehen hat und die danach anderswo geloescht wurde.

const seenOf = (table, id) => db.prepare(`SELECT seen_on_server FROM ${table} WHERE id = ?`).get(id).seen_on_server;

/** Eine Aufgabe, die die alte Buchung zum Spiegel gestempelt hat: kein Objekt oben. */
function phantomTask(listUrl, title = 'Phantom') {
  const id = localTask(listUrl, title);
  const uid = todoOutbound.todoUidFor('tasks', id);
  db.prepare(`
    UPDATE tasks SET external_source = 'caldav', external_uid = ?, external_account_id = ?, external_object_url = ?,
                     target_caldav_account_id = NULL, target_caldav_list_url = NULL
     WHERE id = ?
  `).run(uid, accountId, `${listUrl}${uid}.ics`, id);
  return { id, uid };
}

test('Gesehen: eine nie gesehene, hier angelegte Aufgabe ohne Objekt wird nicht geloescht, sondern hochgeladen (#1839)', async () => {
  reset();
  const list = taskList();
  const { id, uid } = phantomTask(list);

  await remindersSync.sync();
  assert.ok(task(id), 'die Aufgabe wurde als "anderswo geloescht" entfernt');
  assert.equal(task(id).external_source, 'caldav', 'die Aufgabe ging nicht wieder hinauf');
  assert.equal(task(id).external_uid, uid, 'dieselbe UID wie zuvor');
  assert.ok(dav.getObject(list, `${uid}.ics`), 'das Objekt liegt nicht auf dem Server');
  assert.equal(seenOf('tasks', id), 0, 'der Upload selbst belegt nichts');

  // Der naechste Abruf findet es: ab jetzt gesehen.
  await remindersSync.sync();
  assert.equal(seenOf('tasks', id), 1);
});

test('Gesehen: eine Aufgabe, deren Objekt ein Abruf gesehen hat, faellt, wenn es anderswo geloescht wird (#1839)', async () => {
  reset();
  const list = taskList();
  const { id, url } = mirroredTask(list, 'todo-seen@test', 'Gesehen');

  await remindersSync.sync();
  assert.equal(seenOf('tasks', id), 1, 'der Abruf hat die Aufgabe nicht als gesehen markiert');
  dav.removeObject(list, 'todo-seen@test.ics');
  assert.ok(url);
  await remindersSync.sync();
  assert.equal(task(id), undefined, 'eine anderswo geloeschte Aufgabe blieb stehen');
});

test('Gesehen: der erste Lauf nach dem Update loescht nichts, was er nicht gesehen hat (#1839)', async () => {
  reset();
  const list = taskList();
  // Eine fremde Aufgabe aus der Zeit vor der Spalte, deren Objekt fehlt.
  const id = Number(db.prepare(`
    INSERT INTO tasks (title, created_by, external_uid, external_source, external_account_id, external_object_url)
    VALUES ('Fremd', 1, 'foreign@test', 'caldav', ?, ?)
  `).run(accountId, `${list}foreign@test.ics`).lastInsertRowid);
  const phantom = phantomTask(list);

  await remindersSync.sync();
  assert.equal(task(id)?.external_source, 'caldav', 'eine nie gesehene fremde Aufgabe wurde geloescht');
  assert.ok(task(phantom.id), 'eine nie gesehene eigene Aufgabe wurde geloescht');
});

test('Gesehen: ein nie gesehener, hier angelegter Einkaufsartikel ohne Objekt geht wieder hinauf (#1839)', async () => {
  reset();
  const { url, listId } = shoppingList();
  const id = Number(db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(listId, 'Phantom').lastInsertRowid);
  const uid = todoOutbound.todoUidFor('shopping', id);
  db.prepare(`
    UPDATE shopping_items SET external_source = 'caldav', external_uid = ?, external_account_id = ?, external_object_url = ?
     WHERE id = ?
  `).run(uid, accountId, `${url}${uid}.ics`, id);

  await remindersSync.sync();
  const now = db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id);
  assert.ok(now, 'der Artikel wurde als "anderswo geloescht" entfernt');
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.list_id, listId);
  assert.ok(dav.getObject(url, `${uid}.ics`), 'das Objekt liegt nicht auf dem Server');
});

/** Ein Termin, den die alte Buchung zum Spiegel gestempelt hat: kein Objekt oben. */
function phantomEvent(cal) {
  const id = localEvent(cal.url, 'Phantom');
  const uid = eventUidFor(id);
  db.prepare(`
    UPDATE calendar_events SET external_source = 'caldav', external_calendar_id = ?, calendar_ref_id = ?,
                               external_object_url = ?, caldav_account_id = ?
     WHERE id = ?
  `).run(uid, cal.refId, `${cal.url}${uid}.ics`, accountId, id);
  return { id, uid };
}

test('Gesehen: ein nie gesehener, hier angelegter Termin ohne Objekt wird nicht geloescht, sondern hochgeladen (#1839)', async () => {
  reset();
  const cal = calendar();
  const { id, uid } = phantomEvent(cal);

  await caldavSync.sync();
  assert.ok(event(id), 'der Termin wurde als "anderswo geloescht" entfernt');
  assert.equal(event(id).external_source, 'caldav', 'der Termin ging nicht wieder hinauf');
  assert.equal(event(id).external_calendar_id, uid);
  assert.ok(dav.getObject(cal.url, `${uid}.ics`), 'das Objekt liegt nicht auf dem Server');

  await caldavSync.sync();
  assert.equal(seenOf('calendar_events', id), 1);
});

test('Gesehen: ein gesehener Termin faellt, wenn er anderswo geloescht wird; ein nie gesehener fremder bleibt (#1839)', async () => {
  reset();
  const cal = calendar();
  const seen = mirroredEvent(cal, 'evt-seen@test', 'Gesehen');
  const foreign = mirroredEvent(cal, 'evt-foreign@test', 'Fremd');
  dav.removeObject(cal.url, 'evt-foreign@test.ics');

  await caldavSync.sync();
  assert.equal(seenOf('calendar_events', seen.id), 1);
  assert.ok(event(foreign.id), 'ein nie gesehener fremder Termin wurde geloescht');

  dav.removeObject(cal.url, 'evt-seen@test.ics');
  await caldavSync.sync();
  assert.equal(event(seen.id), undefined, 'ein anderswo geloeschter Termin blieb stehen');
});

test('Gesehen: iCloud - ein nie gesehener, hier angelegter Termin ohne Objekt geht wieder hinauf (#1839)', async () => {
  reset();
  const url = dav.addCollection('icloud', { name: 'iCloud' });
  dav.putObject(url, 'neighbour.ics', vevent('apple-neighbour@test', 'Nachbar'));
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  try {
    await appleCalendar.sync();
    const refId = db.prepare("SELECT id FROM external_calendars WHERE source = 'apple' AND external_id = ?").get(url).id;
    const id = Number(db.prepare(`
      INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by, external_source)
      VALUES ('Phantom', '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, 'local')
    `).run().lastInsertRowid);
    const uid = eventUidFor(id);
    db.prepare(`
      UPDATE calendar_events SET external_source = 'apple', external_calendar_id = ?, calendar_ref_id = ?, external_object_url = ?
       WHERE id = ?
    `).run(uid, refId, `${url}${uid}.ics`, id);

    await appleCalendar.sync();
    assert.ok(event(id), 'der Termin wurde als "anderswo geloescht" entfernt');
    assert.equal(event(id).external_source, 'apple', 'der Termin ging nicht wieder hinauf');
    assert.ok(dav.getObject(url, `${uid}.ics`), 'das Objekt liegt nicht in iCloud');
  } finally {
    appleCalendar.clearCredentials();
  }
});

test('Gesehen: auch ein Lauf, der wegen einer nicht abgerufenen Liste nicht prunt, markiert, was er gesehen hat (#1839, Review)', async () => {
  reset();
  const list = taskList();
  const broken = dav.addCollection('broken', { name: 'Kaputt', components: ['VTODO'] });
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'Kaputt', 'tasks', 1)
  `).run(accountId, broken);
  const { id } = mirroredTask(list, 'todo-partial@test', 'Teilweise');

  dav.refuse({ method: 'REPORT', status: 503, when: (req) => req.path === new URL(broken).pathname });
  await remindersSync.sync();
  assertRefused('REPORT', 503);
  assert.equal(seenOf('tasks', id), 1, 'der Abruf hat die Aufgabe geliefert, sie gilt aber nicht als gesehen');
});

test('Gesehen: ein nie gesehener Termin mit wartendem Umzug geht in den Kalender des Umzugs hinauf (#1839, Review)', async () => {
  reset();
  const cal = calendar();
  const other = calendar('other', 'Anderer');
  const { id, uid } = phantomEvent(cal);
  db.prepare('UPDATE calendar_events SET outbound_move_to = ?, target_caldav_calendar_url = ? WHERE id = ?')
    .run(other.url, other.url, id);

  await caldavSync.sync();
  assert.equal(event(id).external_source, 'caldav', 'der Termin ging nicht wieder hinauf');
  assert.ok(dav.getObject(other.url, `${uid}.ics`), 'der Termin liegt nicht im Kalender, den der Nutzer gewaehlt hat');
  assert.equal(dav.getObject(cal.url, `${uid}.ics`), null, 'der Termin ging in den alten Kalender');
});

test('Gesehen: eine nie gesehene Aufgabe mit UID nach dem alten Muster bleibt Spiegel - ein Upload ginge unter neuer UID hinauf (#1839, Review)', async () => {
  reset();
  const list = taskList();
  const id = localTask(list, 'Alt');
  const uid = `yuvomi-task-${id}@yuvomi.local`;
  db.prepare(`
    UPDATE tasks SET external_source = 'caldav', external_uid = ?, external_account_id = ?, external_object_url = ?,
                     target_caldav_account_id = NULL, target_caldav_list_url = NULL
     WHERE id = ?
  `).run(uid, accountId, `${list}${uid}.ics`, id);

  await remindersSync.sync();
  assert.equal(task(id)?.external_uid, uid, 'die Aufgabe mit alter UID wurde geloescht oder zurueckgesetzt');
  assert.equal(dav.seen('PUT').length, 0, 'ein Upload unter neuer UID ging hinaus');
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
