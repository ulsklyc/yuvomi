/**
 * Test: die UID eigener Uploads trägt die Kennung der Installation.
 *
 * Der Anlass: seit eine Absage des Servers als Fehler gilt (#1837), bleibt ein
 * Eintrag lokal, wenn sein Upload scheitert. Das ist richtig - bis auf den einen
 * Fall, in dem der PUT auf dem Server ANKAM und nur die Antwort verloren ging.
 * Dann liegt das Objekt oben, die Zeile ist lokal, der nächste Versuch bekommt
 * 412 ("der Name ist vergeben"), und der nächste Abruf importierte das eigene
 * Objekt als ZWEITE Zeile. Vorher lief dieser Fall nur zufällig zusammen, weil
 * das 412 ungelesen als Erfolg galt.
 *
 * Ein 412 liess sich nicht auflösen, solange die UID nur die Zeilen-Id trug
 * (`yuvomi-task-<id>@yuvomi.local`, `oikos-<id>@oikos.local`): an der Adresse
 * konnte ebenso der Eintrag einer anderen Installation mit derselben Id liegen.
 * Mit der Installationskennung in der UID heisst 412 eindeutig "unseres", und
 * der Abruf erkennt den eigenen Upload einer noch lokalen Zeile.
 *
 * Geprüft wird für alle vier Wege (Aufgabe, Einkaufsartikel, Termin, iCloud):
 *   - beide Reihenfolgen führen zu EINER gespiegelten Zeile mit dem lokalen
 *     Stand auf dem Server: der zweite Upload-Versuch zuerst (412) oder der
 *     Abruf zuerst (Übernahme);
 *   - ein fremdes Objekt unter dem alten Namen wird nicht angefasst;
 *   - zwei Installationen mit derselben Zeilen-Id kollidieren nicht, und die
 *     eine übernimmt nicht das Objekt der anderen;
 *   - eine schon gespiegelte Zeile behält ihre alte UID.
 *
 * Seit #1862 dazu, für dieselben vier Wege: was an der Zeile geschieht,
 * WÄHREND ihre Anfrage unterwegs ist (gelöscht, bearbeitet, ein zweites Mal
 * bearbeitet), geht nicht verloren und kommt nicht zurück.
 *
 * Wie in test-caldav-http-refusals.js: echte Dienste, echter tsdav-Client,
 * echtes HTTP gegen test/caldav-fake-server.js. Eine Attrappe am Client kann
 * "gespeichert, aber mit 500 beantwortet" nicht darstellen.
 *
 * Ausführen: node --experimental-sqlite --test test/test-caldav-own-uid.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const {
  installationId, ownUid, legacyOwnUid, parseOwnUid, isOwnUidOfRow, ownUploadRowId,
  sqlIsOwnEventUidOfRow, sqlLooksLikeOwnEventUid, findObjectWithUid,
} = await import('../server/utils/own-uid.js');
const todoOutbound  = await import('../server/services/caldav-todo-outbound.js');
const remindersSync = await import('../server/services/caldav-reminders-sync.js');
const caldavSync    = await import('../server/services/caldav-sync.js');
const caldavOutbound = await import('../server/services/caldav-outbound.js');
const appleCalendar = await import('../server/services/apple-calendar.js');
const outbound      = await import('../server/services/calendar-outbound.js');
const { createCalDAVClient } = await import('../server/utils/caldav-client.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const dav = await startFakeDavServer();
test.after(() => dav.close());

// ── Fixtures ────────────────────────────────────────────────────────────────────

let accountId;

function reset() {
  for (const table of [
    'caldav_upload_attempts', 'calendar_pending_deletions', 'calendar_events', 'external_calendars',
    'caldav_calendar_selection', 'caldav_todo_pending_deletions', 'tasks',
    'shopping_items', 'shopping_lists', 'caldav_reminder_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  appleCalendar.clearCredentials();
  dav.reset();
  accountId = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Fake', ?, 'u', 'p')
  `).run(dav.url).lastInsertRowid);
}

/** Als wäre dies eine andere Installation: neue Kennung, dieselbe Datenbank. */
function becomeAnotherInstallation() {
  db.prepare("DELETE FROM sync_config WHERE key = 'installation_id'").run();
  return installationId(db);
}

function ics(component, uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    `BEGIN:${component}`, `UID:${uid}`, 'DTSTAMP:20260101T090000Z', `SUMMARY:${summary}`,
    ...(component === 'VEVENT' ? ['DTSTART:20350310T090000Z', 'DTEND:20350310T100000Z'] : ['STATUS:NEEDS-ACTION']),
    `END:${component}`, 'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * Die vier Wege, auf denen ein hier angelegter Eintrag zum Server kommt.
 * `upload()` ist der Lauf, der den PUT schickt; `blindUpload()` derselbe Lauf,
 * in dem der Abruf den eigenen Eintrag NICHT sieht (nötig, wo Abruf und Upload
 * im selben Lauf stecken), sodass der PUT auf das eigene Objekt trifft.
 */
const WAYS = {
  Aufgabe: {
    kind: 'task', component: 'VTODO', table: 'tasks', titleColumn: 'title', uidColumn: 'external_uid', source: 'caldav',
    setup() {
      const url = dav.addCollection('todo', { name: 'Erinnerungen', components: ['VTODO'] });
      dav.putObject(url, 'neighbour.ics', ics('VTODO', 'neighbour@test', 'Nachbar'));
      db.prepare(`
        INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
        VALUES (?, ?, 'Erinnerungen', 'tasks', 1)
      `).run(accountId, url);
      return url;
    },
    create: (url, title) => Number(db.prepare(`
      INSERT INTO tasks (title, created_by, target_caldav_account_id, target_caldav_list_url) VALUES (?, 1, ?, ?)
    `).run(title, accountId, url).lastInsertRowid),
    createMirrored: (url, uid, title, objectUrl) => Number(db.prepare(`
      INSERT INTO tasks (title, created_by, external_uid, external_source, external_account_id, external_object_url)
      VALUES (?, 1, ?, 'caldav', ?, ?)
    `).run(title, uid, accountId, objectUrl).lastInsertRowid),
    upload: () => todoOutbound.flushOutbound(),
    blindUpload: () => todoOutbound.flushOutbound(),
    sync: () => remindersSync.sync(),
    push: () => todoOutbound.flushOutbound(),
  },
  Einkaufsartikel: {
    kind: 'item', component: 'VTODO', table: 'shopping_items', titleColumn: 'name', uidColumn: 'external_uid', source: 'caldav',
    setup() {
      const url = dav.addCollection('shop', { name: 'Einkauf', components: ['VTODO'] });
      dav.putObject(url, 'neighbour.ics', ics('VTODO', 'shop-neighbour@test', 'Nachbar'));
      this.listId = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Einkauf', 1) RETURNING id").get().id;
      db.prepare(`
        INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
        VALUES (?, ?, 'Einkauf', 'shopping', 1, ?)
      `).run(accountId, url, this.listId);
      return url;
    },
    create(url, title) {
      return Number(db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(this.listId, title).lastInsertRowid);
    },
    createMirrored(url, uid, title, objectUrl) {
      return Number(db.prepare(`
        INSERT INTO shopping_items (list_id, name, external_uid, external_source, external_account_id, external_object_url)
        VALUES (?, ?, ?, 'caldav', ?, ?)
      `).run(this.listId, title, uid, accountId, objectUrl).lastInsertRowid);
    },
    upload: () => todoOutbound.flushOutbound(),
    blindUpload: () => todoOutbound.flushOutbound(),
    sync: () => remindersSync.sync(),
    push: () => todoOutbound.flushOutbound(),
  },
  Termin: {
    kind: 'event', component: 'VEVENT', table: 'calendar_events', titleColumn: 'title', uidColumn: 'external_calendar_id', source: 'caldav',
    setup() {
      const url = dav.addCollection('family', { name: 'Familie', components: ['VEVENT'] });
      dav.putObject(url, 'neighbour.ics', ics('VEVENT', 'neighbour@test', 'Nachbar'));
      db.prepare(`
        INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (?, ?, 'Familie', '#4A90E2', 1)
      `).run(accountId, url);
      this.refId = db.prepare(`
        INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav', ?, 'Familie', '#4A90E2') RETURNING id
      `).get(url).id;
      return url;
    },
    create: (url, title) => Number(db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, all_day, created_by, external_source,
         target_caldav_account_id, target_caldav_calendar_url)
      VALUES (?, '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, 'local', ?, ?)
    `).run(title, accountId, url).lastInsertRowid),
    createMirrored(url, uid, title, objectUrl) {
      return Number(db.prepare(`
        INSERT INTO calendar_events
          (title, start_datetime, end_datetime, all_day, created_by, external_source,
           external_calendar_id, calendar_ref_id, external_object_url, caldav_account_id)
        VALUES (?, '2035-03-10T09:00Z', '2035-03-10T10:00Z', 0, 1, 'caldav', ?, ?, ?, ?)
      `).run(title, uid, this.refId, objectUrl, accountId).lastInsertRowid);
    },
    upload: () => caldavSync.sync(),
    async blindUpload() {
      dav.refuse({ method: 'REPORT', status: 503, once: true });
      await caldavSync.sync();
    },
    sync: () => caldavSync.sync(),
    push: () => caldavSync.flushOutbound(),
  },
  'iCloud-Termin': {
    kind: 'event', component: 'VEVENT', table: 'calendar_events', titleColumn: 'title', uidColumn: 'external_calendar_id', source: 'apple',
    setup() {
      const url = dav.addCollection('icloud', { name: 'iCloud', components: ['VEVENT'] });
      dav.putObject(url, 'neighbour.ics', ics('VEVENT', 'neighbour@test', 'Nachbar'));
      appleCalendar.saveCredentials(dav.url, 'u', 'p');
      this.url = url;
      return url;
    },
    create: (url, title) => Number(db.prepare(`
      INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by, external_source)
      VALUES (?, '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, 'local')
    `).run(title).lastInsertRowid),
    createMirrored(url, uid, title, objectUrl) {
      const refId = db.prepare(`
        INSERT INTO external_calendars (source, external_id, name, color) VALUES ('apple', ?, 'iCloud', '#4A90E2')
        ON CONFLICT(source, external_id) DO UPDATE SET name = excluded.name RETURNING id
      `).get(url).id;
      return Number(db.prepare(`
        INSERT INTO calendar_events
          (title, start_datetime, end_datetime, all_day, created_by, external_source,
           external_calendar_id, calendar_ref_id, external_object_url)
        VALUES (?, '2035-03-10T09:00Z', '2035-03-10T10:00Z', 0, 1, 'apple', ?, ?, ?)
      `).run(title, uid, refId, objectUrl).lastInsertRowid);
    },
    upload: () => appleCalendar.sync(),
    async blindUpload() {
      dav.refuse({ method: 'REPORT', status: 503, once: true });
      await appleCalendar.sync();
    },
    sync: () => appleCalendar.sync(),
    push: () => appleCalendar.flushOutbound(),
  },
};

function helpers(way) {
  const row = (id) => db.prepare(`SELECT * FROM ${way.table} WHERE id = ?`).get(id);
  const setTitle = (id, title) => db.prepare(`UPDATE ${way.table} SET ${way.titleColumn} = ? WHERE id = ?`).run(title, id);
  /** Zeilen ausser dem importierten Nachbarn. */
  const rows = () => db.prepare(
    `SELECT * FROM ${way.table} WHERE ${way.titleColumn} <> 'Nachbar' ORDER BY id`
  ).all();
  const names = (url) => dav.objectNames(url).filter((name) => name !== 'neighbour.ics').sort();
  return { row, setTitle, rows, names };
}

/**
 * Führt `action` aus, sobald der n-te PUT beim Server ANKOMMT, also während
 * die Anfrage unterwegs ist: der Dienst wartet auf die Antwort, die Zeile ist
 * längst gelesen. Die Regel lehnt nichts ab (`when` gibt false zurück), der
 * PUT läuft danach normal durch.
 */
function duringPut(action, nth = 1) {
  let seen = 0;
  let ran = false;
  dav.refuse({
    method: 'PUT', status: 500,
    when: () => { if (++seen === nth && !ran) { ran = true; action(); } return false; },
  });
  return () => ran;
}

// ── Die eine Quelle: erzeugen und erkennen ──────────────────────────────────────

test('Installationskennung: einmal erzeugt, dann dieselbe, und sie liegt in der Datenbank', () => {
  db.prepare("DELETE FROM sync_config WHERE key = 'installation_id'").run();
  const first = installationId(db);
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(installationId(db), first, 'der zweite Aufruf hat eine neue Kennung erzeugt');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key = 'installation_id'").get().value, first,
    'die Kennung reist nicht mit der Datenbank');
  assert.notEqual(becomeAnotherInstallation(), first);
});

test('UID: je Zeile fest, je Installation verschieden, beide Muster werden erkannt', () => {
  const inst = installationId(db);
  for (const kind of ['task', 'item', 'event']) {
    const uid = ownUid(kind, 42, db);
    assert.equal(uid, `yuvomi-${kind}-42-${inst}@yuvomi.local`);
    assert.equal(ownUid(kind, 42, db), uid, 'die UID einer Zeile wechselt zwischen zwei Aufrufen');
    assert.deepEqual(parseOwnUid(uid), { kind, id: 42, installation: inst });
    assert.deepEqual(parseOwnUid(legacyOwnUid(kind, 42)), { kind, id: 42, installation: null });

    // Erkennen ("hat Yuvomi das hochgeladen?"): altes und neues Muster.
    assert.equal(isOwnUidOfRow(uid, kind, 42), true);
    assert.equal(isOwnUidOfRow(legacyOwnUid(kind, 42), kind, 42), true);
    assert.equal(isOwnUidOfRow(uid, kind, 43), false);

    // Übernehmen ("das ist der Upload dieser lokalen Zeile"): nur die eigene Kennung.
    assert.equal(ownUploadRowId(uid, kind, db), 42);
    assert.equal(ownUploadRowId(legacyOwnUid(kind, 42), kind, db), null,
      'eine alte UID kann von einer früheren Installation stammen und darf keine Zeile übernehmen');
    assert.equal(ownUploadRowId(`yuvomi-${kind}-42-0123456789abcdef@yuvomi.local`, kind, db), null,
      'die UID einer anderen Installation hat eine Zeile übernommen');
  }
  assert.equal(legacyOwnUid('task', 7), 'yuvomi-task-7@yuvomi.local');
  assert.equal(legacyOwnUid('item', 7), 'yuvomi-item-7@yuvomi.local');
  assert.equal(legacyOwnUid('event', 7), 'oikos-7@oikos.local');
  // Fremdes, ein Einzelvorkommen (`uid::recurrenceId`) und die falsche Art.
  for (const uid of ['neighbour@test', `${ownUid('event', 1, db)}::20350310`, null, '']) {
    assert.equal(parseOwnUid(uid), null, String(uid));
  }
  assert.equal(isOwnUidOfRow(ownUid('task', 42, db), 'item', 42), false);
});

test('UID in SQL: dieselben zwei Muster wie in JS', () => {
  const check = (uid, id) => db.prepare(
    `SELECT ${sqlIsOwnEventUidOfRow('t.uid', 't.id')} AS own, ${sqlLooksLikeOwnEventUid('t.uid')} AS looks
       FROM (SELECT ? AS uid, CAST(? AS INTEGER) AS id) t`
  ).get(uid, id);
  assert.deepEqual({ ...check(ownUid('event', 42, db), 42) }, { own: 1, looks: 1 });
  assert.deepEqual({ ...check(legacyOwnUid('event', 42), 42) }, { own: 1, looks: 1 });
  assert.deepEqual({ ...check(ownUid('event', 42, db), 43) }, { own: 0, looks: 1 }, 'die UID einer anderen Zeile');
  assert.deepEqual({ ...check(`${legacyOwnUid('event', 42)}::20350310`, 42) }, { own: 0, looks: 1 }, 'Einzelvorkommen');
  assert.deepEqual({ ...check('neighbour@test', 42) }, { own: 0, looks: 0 });
  assert.deepEqual({ ...check(null, 42) }, { own: 0, looks: null });
});

test('Serie: die Folgeinstanz erbt das Ziel einer hier entstandenen Aufgabe, altes wie neues Muster', () => {
  reset();
  const list = WAYS.Aufgabe.setup();
  const mirrored = (uid) => {
    const id = Number(db.prepare(`
      INSERT INTO tasks (title, created_by, external_source, external_account_id, external_object_url)
      VALUES ('Serie', 1, 'caldav', ?, ?)
    `).run(accountId, `${list}x.ics`).lastInsertRowid);
    db.prepare('UPDATE tasks SET external_uid = ? WHERE id = ?').run(uid(id), id);
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  };
  const target = { accountId, listUrl: list };
  assert.deepEqual(todoOutbound.recurrenceFollowupTarget(mirrored((id) => ownUid('task', id, db))), target);
  assert.deepEqual(todoOutbound.recurrenceFollowupTarget(mirrored((id) => legacyOwnUid('task', id))), target,
    'eine vor dem Wechsel hochgeladene Serie vererbt ihr Ziel nicht mehr');
  assert.equal(todoOutbound.recurrenceFollowupTarget(mirrored(() => 'from-the-server@test')), null,
    'eine vom Server geholte Aufgabe gilt als hier entstanden');
});

// ── Die vier Wege ───────────────────────────────────────────────────────────────

for (const [label, way] of Object.entries(WAYS)) {
  const { row, setTitle, rows, names } = helpers(way);

  // ── Was während einer laufenden Anfrage geschieht (#1862) ───────────────────
  //
  // Die Zeile wird gelesen, die Anfrage geschickt, das Ergebnis gebucht. Was
  // in der Zeit dazwischen an der Zeile geschah, zählte nicht: ein Löschen
  // liess das Objekt oben stehen und der nächste Abruf holte den Eintrag
  // zurück, eine Bearbeitung wurde als "liegt so auf dem Server" gebucht und
  // vom nächsten Abruf mit dem alten Stand überschrieben.

  test(`${label}: gelöscht, während der Upload läuft - der Eintrag kommt nicht zurück`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    const uid = ownUid(way.kind, id, db);

    const happened = duringPut(() => db.prepare(`DELETE FROM ${way.table} WHERE id = ?`).run(id));
    await way.upload();
    assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
    assert.deepEqual(names(url), [`${uid}.ics`], 'der Upload kam nicht an - der Fall ist nicht nachgestellt');
    dav.allowAll();

    // Folgeläufe: Abruf, Outbound, noch ein Abruf.
    await way.sync();
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist nach dem Abruf zurück');
    await way.push();
    await way.sync();

    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    assert.deepEqual(names(url), [], 'das Objekt des gelöschten Eintrags liegt weiter auf dem Server');
  });

  test(`${label}: bearbeitet, während der Upload läuft - die Bearbeitung bleibt`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Alt');
    const uid = ownUid(way.kind, id, db);

    const happened = duringPut(() => setTitle(id, 'Neu'));
    await way.upload();
    assert.ok(happened());
    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Alt/, 'der Fall ist nicht nachgestellt: oben liegt schon der neue Stand');
    dav.allowAll();

    let now = row(id);
    assert.equal(now.external_source, way.source);
    assert.equal(now.outbound_dirty, 1, 'die Zeile gilt als sauberer Spiegel, obwohl oben der alte Stand liegt');

    await way.sync();
    assert.equal(row(id)[way.titleColumn], 'Neu', 'der Abruf hat die Bearbeitung mit dem alten Stand überschrieben');
    await way.push();
    await way.sync();

    now = row(id);
    assert.equal(rows().length, 1);
    assert.equal(now[way.titleColumn], 'Neu');
    assert.equal(now.outbound_dirty, 0);
    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Neu/, 'auf dem Server liegt nicht die Bearbeitung');
  });

  test(`${label}: bearbeitet, bevor er im selben Lauf an der Reihe ist - hinauf geht der neue Stand`, async () => {
    reset();
    const url    = way.setup();
    const first  = way.create(url, 'Erster');
    const second = way.create(url, 'Alt');
    const uid    = ownUid(way.kind, second, db);

    // Während der Upload des ersten läuft, wird der zweite bearbeitet.
    const happened = duringPut(() => setTitle(second, 'Neu'));
    await way.upload();
    assert.ok(happened());
    dav.allowAll();
    assert.equal(row(first).external_source, way.source);
    // Schon der erste PUT des zweiten trägt die Bearbeitung: die Zeile wird
    // gelesen, wenn sie an der Reihe ist, nicht vor der Schleife.
    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Neu/, 'hinauf ging der Stand von vor der Schleife');
    assert.equal(row(second).outbound_dirty, 0);

    await way.sync();
    await way.push();
    await way.sync();

    const now = row(second);
    assert.equal(now[way.titleColumn], 'Neu', 'der Abruf hat die Bearbeitung mit dem alten Stand überschrieben');
    assert.equal(now.outbound_dirty, 0);
    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Neu/, 'auf dem Server liegt der Stand von vor der Bearbeitung');
  });

  test(`${label}: ein zweites Mal bearbeitet, während die Änderung hinausgeht - die zweite bleibt`, async () => {
    reset();
    const url = way.setup();
    const uid = 'twice@test';
    const { url: objectUrl } = dav.putObject(url, `${uid}.ics`, ics(way.component, uid, 'Alt'));
    const id = way.createMirrored(url, uid, 'Alt', objectUrl);
    const editTo = (title) => db.prepare(
      `UPDATE ${way.table} SET ${way.titleColumn} = ?, outbound_dirty = 1 WHERE id = ?`
    ).run(title, id);

    editTo('Erste');
    const happened = duringPut(() => editTo('Zweite'));
    await way.push();
    assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Erste/);
    dav.allowAll();
    assert.equal(row(id).outbound_dirty, 1, 'die Zeile gilt als sauber, obwohl oben erst die erste Bearbeitung liegt');

    await way.sync();
    assert.equal(row(id)[way.titleColumn], 'Zweite', 'der Abruf hat die zweite Bearbeitung durch die erste ersetzt');
    await way.push();
    await way.sync();

    assert.equal(row(id)[way.titleColumn], 'Zweite');
    assert.equal(row(id).outbound_dirty, 0);
    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Zweite/);
  });

  test(`${label}: gespeichert, aber mit 500 beantwortet - der nächste Upload übernimmt (412)`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Alt');
    const uid = ownUid(way.kind, id, db);

    // Der PUT kommt an, seine Antwort nicht.
    dav.refuse({ method: 'PUT', status: 500, commit: true, once: true });
    await way.upload();
    assert.deepEqual(names(url), [`${uid}.ics`], 'der Server hat das Objekt nicht gespeichert - der Fall ist nicht nachgestellt');
    assert.equal(row(id).external_source, 'local', 'eine 500 gilt als Erfolg');

    // Inzwischen wird hier weitergearbeitet: was am Ende oben liegt, muss der
    // lokale Stand sein, nicht der des verlorenen ersten Versuchs.
    setTitle(id, 'Neu');

    // Zweiter Versuch, ohne dass der Abruf das Objekt vorher sieht: 412.
    await way.blindUpload();
    assert.ok(dav.seen('PUT').some((r) => r.status === 412), 'der zweite Versuch traf nicht auf das eigene Objekt');
    let now = row(id);
    assert.equal(now.external_source, way.source, 'das eigene Objekt wurde nicht übernommen');
    assert.equal(now[way.uidColumn], uid);
    assert.equal(now.outbound_dirty, 1, 'der lokale Stand ist nicht als Änderung vorgemerkt');

    // Folgeläufe: Abruf, Outbound, noch ein Abruf.
    await way.sync();
    await way.push();
    await way.sync();

    assert.equal(rows().length, 1, `aus einem Eintrag sind ${rows().length} Zeilen geworden`);
    now = row(id);
    assert.equal(now.external_source, way.source);
    assert.equal(now[way.titleColumn], 'Neu', 'der Abruf hat den lokalen Stand überschrieben');
    assert.equal(now.outbound_dirty, 0);
    assert.deepEqual(names(url), [`${uid}.ics`], 'auf dem Server liegt mehr als ein Objekt');
    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Neu/, 'auf dem Server liegt nicht der lokale Stand');
  });

  test(`${label}: gespeichert, aber mit 500 beantwortet - der Abruf kommt zuerst und übernimmt`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Alt');
    const uid = ownUid(way.kind, id, db);

    dav.refuse({ method: 'PUT', status: 500, commit: true, once: true });
    await way.upload();
    assert.deepEqual(names(url), [`${uid}.ics`]);
    assert.equal(row(id).external_source, 'local');
    setTitle(id, 'Neu');

    // Diesmal sieht der Abruf das eigene Objekt, bevor ein zweiter PUT läuft.
    const putsBefore = dav.seen('PUT').length;
    await way.sync();
    assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
    assert.equal(dav.seen('PUT').filter((r) => r.status === 412).length, 0, 'es lief doch ein zweiter Anlege-Versuch');
    assert.ok(dav.seen('PUT').length >= putsBefore);

    await way.push();
    await way.sync();

    // Derselbe Endzustand wie auf dem anderen Weg.
    assert.equal(rows().length, 1);
    const now = row(id);
    assert.equal(now.external_source, way.source);
    assert.equal(now[way.uidColumn], uid);
    assert.equal(now[way.titleColumn], 'Neu', 'der Abruf hat den lokalen Stand überschrieben');
    assert.equal(now.outbound_dirty, 0);
    assert.deepEqual(names(url), [`${uid}.ics`]);
    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Neu/, 'auf dem Server liegt nicht der lokale Stand');
  });

  test(`${label}: ein fremdes Objekt unter dem alten Namen bleibt unangetastet`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Unseres');
    // Eine frühere Installation hat unter derselben Zeilen-Id hochgeladen.
    const legacy = legacyOwnUid(way.kind, id);
    dav.putObject(url, `${legacy}.ics`, ics(way.component, legacy, 'Fremd'));

    await way.upload();
    await way.sync();

    const uid = ownUid(way.kind, id, db);
    assert.match(dav.getObject(url, `${legacy}.ics`).data, /SUMMARY:Fremd/, 'das fremde Objekt wurde überschrieben');
    assert.deepEqual(names(url), [`${legacy}.ics`, `${uid}.ics`].sort(), 'der Eintrag ging nicht unter eigenem Namen hinauf');
    const now = row(id);
    assert.equal(now.external_source, way.source, 'der Upload blieb am fremden Objekt hängen');
    assert.equal(now[way.uidColumn], uid);
    assert.equal(now[way.titleColumn], 'Unseres', 'die Zeile wurde mit dem fremden Objekt verschmolzen');
    // Das fremde Objekt ist ein Eintrag wie jeder andere auf dem Server.
    assert.deepEqual(rows().map((r) => r[way.titleColumn]).sort(), ['Fremd', 'Unseres']);
  });

  test(`${label}: zwei Installationen mit derselben Zeilen-Id kollidieren nicht`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Unseres');
    // Die andere Installation hat ihre Zeile mit derselben Id schon oben.
    const theirs = ownUid(way.kind, id, db);
    dav.putObject(url, `${theirs}.ics`, ics(way.component, theirs, 'Von der anderen'));
    becomeAnotherInstallation();
    const ours = ownUid(way.kind, id, db);
    assert.notEqual(ours, theirs);

    // Abruf zuerst: das Objekt der anderen trägt DEREN Kennung und darf unsere
    // lokale Zeile nicht übernehmen.
    await way.sync();
    await way.upload();
    await way.sync();

    const now = row(id);
    assert.equal(now[way.titleColumn], 'Unseres', 'das Objekt der anderen Installation wurde in unsere Zeile übernommen');
    assert.equal(now.external_source, way.source);
    assert.equal(now[way.uidColumn], ours);
    assert.match(dav.getObject(url, `${theirs}.ics`).data, /SUMMARY:Von der anderen/, 'ihr Objekt wurde überschrieben');
    assert.match(dav.getObject(url, `${ours}.ics`).data, /SUMMARY:Unseres/);
    assert.deepEqual(rows().map((r) => r[way.titleColumn]).sort(), ['Unseres', 'Von der anderen']);
  });

  test(`${label}: eine schon gespiegelte Zeile behält ihre alte UID`, async () => {
    reset();
    const url = way.setup();
    // Platzhalter-Zeile, um die Id zu kennen, bevor das Objekt angelegt wird.
    const probe = way.createMirrored(url, 'pending', 'Alt', `${url}pending.ics`);
    const legacy = legacyOwnUid(way.kind, probe);
    const { url: objectUrl } = dav.putObject(url, `${legacy}.ics`, ics(way.component, legacy, 'Alt'));
    db.prepare(`UPDATE ${way.table} SET ${way.uidColumn} = ?, external_object_url = ? WHERE id = ?`).run(legacy, objectUrl, probe);

    await way.sync();
    db.prepare(`UPDATE ${way.table} SET ${way.titleColumn} = 'Neu', outbound_dirty = 1 WHERE id = ?`).run(probe);
    await way.push();
    await way.sync();

    const now = row(probe);
    assert.equal(now[way.uidColumn], legacy, 'eine gespiegelte Zeile wurde umbenannt');
    assert.equal(now.external_object_url, objectUrl);
    assert.equal(now.outbound_dirty, 0);
    assert.deepEqual(names(url), [`${legacy}.ics`], 'neben dem alten Objekt ist ein zweites entstanden');
    assert.match(dav.getObject(url, `${legacy}.ics`).data, /SUMMARY:Neu/);
    assert.equal(rows().length, 1);
  });
}

// ── Die UID kommt vom Server und ist kein Ausweis ───────────────────────────────
//
// Die Installationskennung steht in jeder UID auf jedem Server, mit dem je
// synchronisiert wurde. Wer in eine Collection schreiben darf - der Server
// selbst, oder jemand, mit dem sie geteilt ist -, kann dort ein Objekt mit einer
// UID im Muster dieser Installation und einer beliebigen Zeilen-Id ablegen.
// Übernähme der Abruf daraufhin "die lokale Zeile mit dieser Id", bände er eine
// fremde Zeile an dieses Konto, merkte sie als geändert vor, und ihr Inhalt
// ginge mit dem nächsten Outbound auf diesen Server.

const snapshot = (table, id) => {
  const row = { ...db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) };
  delete row.updated_at;
  return row;
};

/** Legt in `plantUrl` ein Objekt ab, dessen UID auf die lokale Zeile `id` zeigt. */
function plant(way, plantUrl, id) {
  const uid = ownUid(way.kind, id, db);
  dav.putObject(plantUrl, `${uid}.ics`, ics(way.component, uid, 'Planted'));
  return uid;
}

/** Was nach jedem untergeschobenen Objekt gelten muss. */
function assertNotExfiltrated(way, plantUrl, uid) {
  const plantPath = new URL(plantUrl).pathname;
  assert.match(dav.getObject(plantUrl, `${uid}.ics`).data, /SUMMARY:Planted/,
    'das untergeschobene Objekt wurde mit dem lokalen Stand überschrieben');
  const leaked = dav.requests.filter((r) => r.path.startsWith(plantPath) && r.body.includes('Geheim'));
  assert.equal(leaked.length, 0, `der Inhalt der Zeile ging an ${plantPath}: ${leaked.map((r) => r.method).join(', ')}`);
  // Das Objekt ist ein Eintrag wie jeder andere auf dem Server: ein Import.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${way.table} WHERE ${way.titleColumn} = 'Planted'`).get().n, 1,
    'das untergeschobene Objekt wurde nicht als eigene Zeile importiert');
}

async function runAll(way) {
  await way.sync();
  await way.push();
  await way.sync();
}

/**
 * Der eine Lauf, in dem die Zeile noch auf ihren Upload wartet - für die Fälle,
 * in denen sie danach rechtmässig woanders gespiegelt ist. Ein weiterer Abruf
 * träfe dann auf ZWEI Objekte mit derselben UID in einem Konto, und was der
 * Abruf daraus macht, ist eine ältere Regel als die Übernahme (er liest die UID
 * als Identität über die Collections des Kontos hinweg).
 */
async function runOnce(way) {
  await way.sync();
  await way.push();
}

test('Aufgabe ohne Upload-Ziel: ein untergeschobenes Objekt mit ihrer UID übernimmt sie nicht', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const url = way.setup();
  const id = Number(db.prepare(`
    INSERT INTO tasks (title, description, created_by, assigned_to, visibility)
    VALUES ('Geheim', 'Geheim: nur für mich', 1, 1, 'private')
  `).run().lastInsertRowid);
  const before = snapshot('tasks', id);
  const uid = plant(way, url, id);

  await runAll(way);

  assert.deepEqual(snapshot('tasks', id), before, 'eine Aufgabe, die nie hochgeladen werden sollte, wurde angefasst');
  assert.equal(dav.requests.filter((r) => r.body.includes('Geheim')).length, 0, 'ihr Inhalt hat den Server erreicht');
  assertNotExfiltrated(way, url, uid);
});

test('Aufgabe für eine ANDERE Liste: das Objekt in dieser Liste übernimmt sie nicht', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const url = way.setup();
  const other = dav.addCollection('todo2', { name: 'Privat', components: ['VTODO'] });
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'Privat', 'tasks', 1)
  `).run(accountId, other);
  const id = way.create(other, 'Geheim');
  const uid = plant(way, url, id);

  await runOnce(way);

  // Sie geht dorthin, wohin sie sollte - und nur dorthin.
  const now = snapshot('tasks', id);
  assert.equal(now.external_object_url, `${other}${uid}.ics`, 'die Aufgabe wurde an die falsche Liste gebunden');
  assert.match(dav.getObject(other, `${uid}.ics`).data, /SUMMARY:Geheim/);
  assertNotExfiltrated(way, url, uid);
});

test('Aufgabe für ein ANDERES Konto: das Objekt in der Liste dieses Kontos übernimmt sie nicht', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const url = way.setup();
  const otherAccount = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Zweites', ?, 'u2', 'p2')
  `).run(dav.url).lastInsertRowid);
  const id = Number(db.prepare(`
    INSERT INTO tasks (title, created_by, target_caldav_account_id, target_caldav_list_url) VALUES ('Geheim', 1, ?, ?)
  `).run(otherAccount, url).lastInsertRowid);
  const uid = plant(way, url, id);

  await runAll(way);

  const now = snapshot('tasks', id);
  assert.equal(now.external_source, 'local', 'die Aufgabe eines anderen Kontos wurde an dieses gebunden');
  assert.equal(now.external_account_id, null);
  assertNotExfiltrated(way, url, uid);
});

test('Einkaufsartikel einer NICHT zugeordneten Liste: das Objekt übernimmt ihn nicht', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const url = way.setup();
  const privateList = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Privat', 1) RETURNING id").get().id;
  const id = Number(db.prepare(
    "INSERT INTO shopping_items (list_id, name, notes) VALUES (?, 'Geheim', 'Geheim: Geschenk')"
  ).run(privateList).lastInsertRowid);
  const before = snapshot('shopping_items', id);
  const uid = plant(way, url, id);

  await runAll(way);

  assert.deepEqual(snapshot('shopping_items', id), before, 'ein Artikel einer nicht gespiegelten Liste wurde angefasst');
  assert.equal(dav.requests.filter((r) => r.body.includes('Geheim')).length, 0, 'sein Inhalt hat den Server erreicht');
  assertNotExfiltrated(way, url, uid);
});

test('Termin ohne Upload-Ziel: ein untergeschobenes Objekt mit seiner UID übernimmt ihn nicht', async () => {
  reset();
  const way = WAYS.Termin;
  const url = way.setup();
  const id = Number(db.prepare(`
    INSERT INTO calendar_events (title, description, start_datetime, end_datetime, all_day, created_by, assigned_to, external_source, visibility)
    VALUES ('Geheim', 'Geheim: Arzt', '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, 1, 'local', 'private')
  `).run().lastInsertRowid);
  const before = snapshot('calendar_events', id);
  const uid = plant(way, url, id);

  await runAll(way);

  assert.deepEqual(snapshot('calendar_events', id), before, 'ein Termin, der nie hochgeladen werden sollte, wurde angefasst');
  assert.equal(dav.requests.filter((r) => r.body.includes('Geheim')).length, 0, 'sein Inhalt hat den Server erreicht');
  assertNotExfiltrated(way, url, uid);
});

test('Termin für einen ANDEREN Kalender: das Objekt in diesem Kalender übernimmt ihn nicht', async () => {
  reset();
  const way = WAYS.Termin;
  const url = way.setup();
  const other = dav.addCollection('private', { name: 'Privat', components: ['VEVENT'] });
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Privat', '#4A90E2', 1)
  `).run(accountId, other);
  const id = way.create(other, 'Geheim');
  const uid = plant(way, url, id);

  await runOnce(way);

  const now = snapshot('calendar_events', id);
  assert.equal(now.external_object_url, `${other}${uid}.ics`, 'der Termin wurde an den falschen Kalender gebunden');
  assert.match(dav.getObject(other, `${uid}.ics`).data, /SUMMARY:Geheim/);
  assertNotExfiltrated(way, url, uid);
});

test('Termin für ein ANDERES Konto: das Objekt im Kalender dieses Kontos übernimmt ihn nicht', async () => {
  reset();
  const way = WAYS.Termin;
  const url = way.setup();
  const otherAccount = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Zweites', ?, 'u2', 'p2')
  `).run(dav.url).lastInsertRowid);
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source,
       target_caldav_account_id, target_caldav_calendar_url)
    VALUES ('Geheim', '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, 'local', ?, ?)
  `).run(otherAccount, url).lastInsertRowid);
  const before = snapshot('calendar_events', id);
  const uid = plant(way, url, id);

  await runAll(way);

  // Das zweite Konto hat keinen Kalender ausgewählt, sein Lauf fasst nichts an.
  assert.deepEqual(snapshot('calendar_events', id), before, 'der Termin eines anderen Kontos wurde an dieses gebunden');
  assertNotExfiltrated(way, url, uid);
});

test('iCloud-Termin: ein Objekt in einem ANDEREN als dem Upload-Kalender übernimmt ihn nicht', async () => {
  reset();
  const way = WAYS['iCloud-Termin'];
  const first = way.setup();
  // Uploads gehen in den ERSTEN Kalender; das Objekt liegt im zweiten.
  const second = dav.addCollection('shared', { name: 'Geteilt', components: ['VEVENT'] });
  const id = way.create(first, 'Geheim');
  const uid = plant(way, second, id);

  await runOnce(way);

  const now = snapshot('calendar_events', id);
  assert.equal(now.external_object_url, `${first}${uid}.ics`, 'der Termin wurde an den Kalender des untergeschobenen Objekts gebunden');
  assertNotExfiltrated(way, second, uid);
});

for (const [label, way] of Object.entries(WAYS)) {
  const { row, rows, names } = helpers(way);

  test(`${label}: am eigenen Namen liegt ein Objekt mit FREMDER UID - nicht übernommen, nicht überschrieben`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Geheim');
    const uid = ownUid(way.kind, id, db);
    // Der Dateiname ist unserer, die UID im Objekt nicht: aus dem Namen allein
    // darf niemand schliessen, dass das unser Upload ist.
    dav.putObject(url, `${uid}.ics`, ics(way.component, 'somebody-else@test', 'Fremd'));

    await way.blindUpload();
    assert.ok(dav.seen('PUT').some((r) => r.status === 412), 'der Upload traf nicht auf das Objekt');
    await runAll(way);

    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Fremd/, 'das fremde Objekt wurde überschrieben');
    assert.match(dav.getObject(url, `${uid}.ics`).data, /UID:somebody-else@test/);
    assert.equal(row(id).external_source, 'local', 'die Zeile wurde an ein fremdes Objekt gebunden');
    assert.deepEqual(names(url), [`${uid}.ics`]);
  });

  test(`${label}: beim Übernehmen überschreibt der Serverinhalt nichts`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Alt');
    if (way.table !== 'shopping_items') {
      db.prepare(`UPDATE ${way.table} SET visibility = 'private', assigned_to = 1, description = 'lokal' WHERE id = ?`).run(id);
    } else {
      db.prepare("UPDATE shopping_items SET notes = 'lokal', quantity = '3' WHERE id = ?").run(id);
    }
    const uid = ownUid(way.kind, id, db);

    dav.refuse({ method: 'PUT', status: 500, commit: true, once: true });
    await way.upload();
    assert.equal(row(id).external_source, 'local');
    // Zwischen dem verlorenen PUT und dem Abruf hat jemand das Objekt auf dem
    // Server verändert.
    dav.putObject(url, `${uid}.ics`, ics(way.component, uid, 'Manipuliert'));
    const before = snapshot(way.table, id);

    // Abruf (übernimmt) und Outbound. Verglichen wird VOR dem nächsten Abruf:
    // der liest das eben hochgeladene Objekt zurück und schreibt dabei die
    // Zeiten in der Schreibweise des Servers - das tut er nach jedem Upload.
    await way.sync();
    await way.push();

    const after = snapshot(way.table, id);
    const SYNC_COLUMNS = [
      'external_source', 'external_uid', 'external_calendar_id', 'external_account_id', 'external_object_url',
      'calendar_ref_id', 'outbound_dirty', 'outbound_attempts', 'target_caldav_account_id', 'target_caldav_list_url',
      'color_modified', 'caldav_account_id',
    ];
    for (const column of SYNC_COLUMNS) { delete before[column]; delete after[column]; }
    assert.deepEqual(after, before, 'der Inhalt vom Server hat lokale Felder überschrieben');
    assert.equal(row(id).external_source, way.source);
    await way.sync();
    assert.equal(rows().length, 1);
    assert.equal(row(id)[way.titleColumn], 'Alt');
    assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Alt/, 'der lokale Stand ging nicht hinauf');
  });
}

// ── Nur eine UNGESPIEGELTE Zeile wird übernommen ────────────────────────────────
//
// Der Regelfall jeder Bestandsinstallation: ihre hochgeladenen Einträge liegen
// unter dem ALTEN Muster auf dem Server. Ein Objekt im neuen Muster mit der Id
// einer solchen Zeile findet der Abruf deshalb nicht als "schon vorhanden" und
// fragt die Übernahme. Ginge sie durch, hinge die Zeile danach am
// untergeschobenen Objekt, ihr eigenes bliebe verwaist zurück, und ihr Inhalt
// ginge an die Adresse, die der Server genannt hat.

for (const [label, way] of Object.entries(WAYS)) {
  const { row } = helpers(way);

  test(`${label}: eine schon gespiegelte Zeile wird von einem Objekt mit ihrer Id nicht umgebunden`, async () => {
    reset();
    const url = way.setup();
    const id = way.createMirrored(url, 'pending', 'Geheim', `${url}pending.ics`);
    const legacy = legacyOwnUid(way.kind, id);
    const { url: objectUrl } = dav.putObject(url, `${legacy}.ics`, ics(way.component, legacy, 'Geheim'));
    db.prepare(`UPDATE ${way.table} SET ${way.uidColumn} = ?, external_object_url = ? WHERE id = ?`).run(legacy, objectUrl, id);
    // So steht ein vor dem Wechsel hochgeladener Termin da: gespiegelt, und die
    // Zielspalten nennen weiter den Kalender, in den er ging.
    if (way === WAYS.Termin) {
      db.prepare('UPDATE calendar_events SET target_caldav_account_id = ?, target_caldav_calendar_url = ? WHERE id = ?')
        .run(accountId, url, id);
    }
    const uid = plant(way, url, id);

    await runAll(way);

    const now = row(id);
    assert.equal(now[way.uidColumn], legacy, 'die gespiegelte Zeile wurde an das untergeschobene Objekt gebunden');
    assert.equal(now.external_object_url, objectUrl);
    assert.equal(now.outbound_dirty, 0, 'die gespiegelte Zeile wurde als geändert vorgemerkt');
    assert.match(dav.getObject(url, `${legacy}.ics`).data, /SUMMARY:Geheim/);
    assertNotExfiltrated(way, url, uid);
  });
}

test('Einkaufsartikel einer ANDERS zugeordneten Liste: das Objekt in dieser Liste übernimmt ihn nicht', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const url = way.setup();
  const other = dav.addCollection('shop2', { name: 'Privat', components: ['VTODO'] });
  const privateList = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Privat', 1) RETURNING id").get().id;
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'Privat', 'shopping', 1, ?)
  `).run(accountId, other, privateList);
  const id = Number(db.prepare("INSERT INTO shopping_items (list_id, name) VALUES (?, 'Geheim')").run(privateList).lastInsertRowid);
  const uid = plant(way, url, id);

  await runOnce(way);

  const now = snapshot('shopping_items', id);
  assert.equal(now.external_object_url, `${other}${uid}.ics`, 'der Artikel wurde an die falsche Liste gebunden');
  assert.equal(now.list_id, privateList);
  assert.match(dav.getObject(other, `${uid}.ics`).data, /SUMMARY:Geheim/);
  assertNotExfiltrated(way, url, uid);
});

// ── Die Übernahme selbst, Bedingung für Bedingung ───────────────────────────────
//
// Dieselben Regeln ohne Server dazwischen: jede Ablehnung steht neben dem Aufruf,
// der sich nur in dieser einen Angabe unterscheidet und DURCHGEHT. Ohne diese
// Gegenprobe könnte ein Fall aus einem ganz anderen Grund abgelehnt worden sein.

test('adoptOwnUpload (Aufgabe): nur lokal, nur dieses Konto, nur diese Liste, nur die eigene Adresse und UID', () => {
  reset();
  const way = WAYS.Aufgabe;
  const list = way.setup();
  const otherList = `${dav.url}cal/elsewhere/`;
  const otherAccount = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Zweites', ?, 'u2', 'p2')
  `).run(dav.url).lastInsertRowid);
  const id = way.create(list, 'Geheim');
  const uid = ownUid('task', id, db);
  const good = [uid, accountId, `${list}${uid}.ics`, { listUrl: list }];
  const before = snapshot('tasks', id);
  const refused = (why, ...args) => {
    assert.equal(todoOutbound.adoptOwnUpload('tasks', ...args), false, why);
    assert.deepEqual(snapshot('tasks', id), before, `${why} - und die Zeile wurde trotzdem angefasst`);
  };

  refused('ein anderes Konto', uid, otherAccount, good[2], good[3]);
  refused('eine andere Liste', uid, accountId, `${otherList}${uid}.ics`, { listUrl: otherList });
  refused('das Objekt liegt nicht in der abgerufenen Liste', uid, accountId, `${otherList}${uid}.ics`, good[3]);
  refused('das Objekt liegt auf einem anderen Host', uid, accountId,
    `http://evil.example${new URL(list).pathname}${uid}.ics`, good[3]);
  refused('ohne Angabe der Liste', uid, accountId, good[2], {});
  refused('ohne Angabe der Liste', uid, accountId, good[2]);
  refused('eine UID, die wir so nie erzeugen', uid.replace(`-${id}-`, `-0${id}-`), accountId,
    `${list}${uid.replace(`-${id}-`, `-0${id}-`)}.ics`, good[3]);
  refused('das alte Muster', legacyOwnUid('task', id), accountId, `${list}${legacyOwnUid('task', id)}.ics`, good[3]);
  refused('die falsche Art', ownUid('item', id, db), accountId, `${list}${ownUid('item', id, db)}.ics`, good[3]);

  // Schon gespiegelt (an ein anderes Konto), die Zielspalten stehen aber noch:
  // allein `external_source` hält die Übernahme auf.
  db.prepare(`
    UPDATE tasks SET external_source = 'caldav', external_uid = 'theirs@test', external_account_id = ?,
                     external_object_url = ? WHERE id = ?
  `).run(otherAccount, `${otherList}theirs.ics`, id);
  const mirrored = snapshot('tasks', id);
  assert.equal(todoOutbound.adoptOwnUpload('tasks', ...good), false, 'eine gespiegelte Zeile wurde übernommen');
  assert.deepEqual(snapshot('tasks', id), mirrored);

  // Die Gegenprobe: dieselbe Zeile, wieder lokal, dieselben Angaben.
  db.prepare(`
    UPDATE tasks SET external_source = 'local', external_uid = NULL, external_account_id = NULL,
                     external_object_url = NULL WHERE id = ?
  `).run(id);
  assert.equal(todoOutbound.adoptOwnUpload('tasks', ...good), true, 'die wartende Zeile wurde nicht übernommen');
  const now = snapshot('tasks', id);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.external_account_id, accountId);
  assert.equal(now.external_object_url, good[2]);
  assert.equal(now.outbound_dirty, 1);
  assert.equal(now.title, 'Geheim');
});

test('adoptOwnUpload (Einkauf): nur lokal, nur die zugeordnete Liste, nur die eigene Adresse', () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const list = way.setup();
  const otherList = `${dav.url}cal/elsewhere/`;
  const unmapped = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Privat', 1) RETURNING id").get().id;
  const id = way.create(list, 'Geheim');
  const uid = ownUid('item', id, db);
  const good = [uid, accountId, `${list}${uid}.ics`, { listUrl: list, targetListId: way.listId }];
  const before = snapshot('shopping_items', id);
  const refused = (why, ...args) => {
    assert.equal(todoOutbound.adoptOwnUpload('shopping', ...args), false, why);
    assert.deepEqual(snapshot('shopping_items', id), before, `${why} - und die Zeile wurde trotzdem angefasst`);
  };

  refused('eine andere Yuvomi-Liste', uid, accountId, good[2], { listUrl: list, targetListId: unmapped });
  refused('ohne zugeordnete Yuvomi-Liste', uid, accountId, good[2], { listUrl: list });
  refused('das Objekt liegt nicht in der abgerufenen Liste', uid, accountId, `${otherList}${uid}.ics`, good[3]);

  db.prepare("UPDATE shopping_items SET external_source = 'caldav', external_uid = 'theirs@test' WHERE id = ?").run(id);
  const mirrored = snapshot('shopping_items', id);
  assert.equal(todoOutbound.adoptOwnUpload('shopping', ...good), false, 'ein gespiegelter Artikel wurde übernommen');
  assert.deepEqual(snapshot('shopping_items', id), mirrored);

  db.prepare("UPDATE shopping_items SET external_source = 'local', external_uid = NULL WHERE id = ?").run(id);
  assert.equal(todoOutbound.adoptOwnUpload('shopping', ...good), true, 'der wartende Artikel wurde nicht übernommen');
  assert.equal(snapshot('shopping_items', id).external_object_url, good[2]);
});

test('adoptOwnEventUpload: nur lokal, nur wenn der Aufrufer das Warten bestätigt, nur die eigene Adresse und UID', () => {
  reset();
  const way = WAYS.Termin;
  const cal = way.setup();
  const otherCal = `${dav.url}cal/elsewhere/`;
  const id = way.create(cal, 'Geheim');
  const uid = ownUid('event', id, db);
  const asked = [];
  const good = {
    source: 'caldav', uid, objectUrl: `${cal}${uid}.ics`, calendarUrl: cal, calRefId: way.refId, accountId,
    isWaitingHere: (eventId) => { asked.push(eventId); return true; },
  };
  const before = snapshot('calendar_events', id);
  const refused = (why, change) => {
    assert.equal(outbound.adoptOwnEventUpload({ ...good, ...change }), false, why);
    assert.deepEqual(snapshot('calendar_events', id), before, `${why} - und der Termin wurde trotzdem angefasst`);
  };

  refused('der Aufrufer bestätigt das Warten nicht', { isWaitingHere: () => false });
  refused('ohne Prüfung des Aufrufers', { isWaitingHere: undefined });
  refused('ohne Angabe des Kalenders', { calendarUrl: undefined });
  refused('das Objekt liegt nicht im abgerufenen Kalender', { objectUrl: `${otherCal}${uid}.ics` });
  refused('das Objekt liegt auf einem anderen Host', { objectUrl: `http://evil.example${new URL(cal).pathname}${uid}.ics` });
  const zero = uid.replace(`-${id}-`, `-0${id}-`);
  refused('eine UID, die wir so nie erzeugen', { uid: zero, objectUrl: `${cal}${zero}.ics` });
  const legacy = legacyOwnUid('event', id);
  refused('das alte Muster', { uid: legacy, objectUrl: `${cal}${legacy}.ics` });

  // Schon gespiegelt: auch ein Aufrufer, der fälschlich "wartet hier" sagt,
  // bekommt die Zeile nicht.
  db.prepare("UPDATE calendar_events SET external_source = 'caldav', external_calendar_id = 'theirs@test' WHERE id = ?").run(id);
  const mirrored = snapshot('calendar_events', id);
  assert.equal(outbound.adoptOwnEventUpload(good), false, 'ein gespiegelter Termin wurde übernommen');
  assert.deepEqual(snapshot('calendar_events', id), mirrored);

  db.prepare("UPDATE calendar_events SET external_source = 'local', external_calendar_id = NULL WHERE id = ?").run(id);
  asked.length = 0;
  assert.equal(outbound.adoptOwnEventUpload(good), true, 'der wartende Termin wurde nicht übernommen');
  assert.deepEqual(asked, [id], 'gefragt wurde nicht nach der Zeile aus der UID');
  const now = snapshot('calendar_events', id);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.external_object_url, good.objectUrl);
  assert.equal(now.caldav_account_id, accountId, 'der übernommene Termin gehört nicht dem Konto, das ihn abgerufen hat');
  assert.equal(now.outbound_dirty, 1);
  assert.equal(now.title, 'Geheim');
});

test('412: gelesen wird das Objekt an genau dieser Adresse, und gemerkt wird nur sie', async () => {
  const collection = 'https://dav.example/cal/todo/';
  const uid = ownUid('task', 7, db);
  const objectUrl = `${collection}${uid}.ics`;
  const asked = [];
  const answering = (objects) => ({
    fetchCalendarObjects: async (params) => { asked.push(params); return objects; },
  });
  const find = (objects) => findObjectWithUid(answering(objects), collection, objectUrl, uid);
  const ours = ics('VTODO', uid, 'Unseres');

  // Der Server schickt ein Objekt mit, nach dem nicht gefragt war. Es trägt
  // unsere UID - aber es liegt nicht unter dem Namen, der vergeben ist.
  assert.equal(await find([{ url: `${collection}somewhere-else.ics`, etag: '"1"', data: ours }]), null,
    'ein Objekt an anderer Adresse galt als das unter dem vergebenen Namen');
  assert.equal(await find([{ url: `https://dav.example/cal/shared/${uid}.ics`, etag: '"1"', data: ours }]), null,
    'ein Objekt in einer anderen Collection galt als das unter dem vergebenen Namen');
  assert.equal(await find([{ url: objectUrl, etag: '"1"', data: ics('VTODO', 'somebody-else@test', 'Fremd') }]), null,
    'ein Objekt mit fremder UID galt als unseres');
  assert.equal(await find([]), null);
  assert.equal(await find(undefined), null);

  // Dieselbe Adresse in der Schreibweise des Servers (`@` als `%40`).
  const encoded = `${collection}${uid.replaceAll('@', '%40')}.ics`;
  assert.notEqual(encoded, objectUrl);
  assert.deepEqual(await find([{ url: encoded, etag: '"2"', data: ours }]), { url: objectUrl, etag: '"2"', data: ours },
    'die Adresse aus der Antwort wurde übernommen statt der angefragten');
  // Gefaltete UID-Zeile und fremde Objekte davor.
  const folded = ours.replace(`UID:${uid}`, `UID:${uid.slice(0, 10)}\r\n ${uid.slice(10)}`);
  assert.equal((await find([
    { url: `${collection}neighbour.ics`, etag: '"0"', data: ics('VTODO', 'neighbour@test', 'Nachbar') },
    { url: objectUrl, etag: '"3"', data: folded },
  ])).etag, '"3"');
  assert.deepEqual(asked.at(-1), { calendar: { url: collection }, objectUrls: [objectUrl] });
});

// ── Umzug ohne Kalenderliste: unbekannt ist nicht verschwunden ──────────────────

test('Umzug: ohne Kalenderliste wartet er - auch wenn der Aufrufer keine mitgibt', async () => {
  reset();
  const way = WAYS.Termin;
  const url = way.setup();
  const dest = dav.addCollection('work', { name: 'Arbeit', components: ['VEVENT'] });
  const { url: objectUrl, etag } = dav.putObject(url, 'move@test.ics', ics('VEVENT', 'move@test', 'Zieht um'));
  const id = way.createMirrored(url, 'move@test', 'Zieht um', objectUrl);
  db.prepare('UPDATE calendar_events SET outbound_move_to = ? WHERE id = ?').run(dest, id);
  const client = await createCalDAVClient({ caldav_url: dav.url, username: 'u', password: 'p' });
  const index = new Map([['move@test', { url: objectUrl, etag, data: dav.getObject(url, 'move@test.ics').data, calendarUrl: url }]]);
  const moveTo = () => db.prepare('SELECT outbound_move_to FROM calendar_events WHERE id = ?').get(id).outbound_move_to;

  // Die Vorgabe des Parameters: früher eine leere Map, also "das Ziel gibt es nicht".
  await caldavOutbound.processPendingUpdates(client, 'caldav', index);
  assert.equal(moveTo(), dest, 'ohne Kalenderliste wurde der Umzug verworfen');

  // Der Sofortversuch, dem beim Auswählen der Arbeit noch kein Umzug vorlag
  // (needsCalendars = false) - er ist während eines await dazugekommen.
  const pending = outbound.pendingUpdates('caldav').map((e) => ({ ...e, __calendarUrl: url }));
  await caldavOutbound.flushAccount(client, 'caldav', { deletions: [], updates: pending, needsCalendars: false });
  assert.equal(moveTo(), dest, 'ein dazwischen vorgemerkter Umzug wurde verworfen');
  assert.equal(dav.seen('PUT').length, 0);
});

// ── Das Ziel wechselt, während der Upload unterwegs ist (#1881) ─────────────────
//
// Die Zeile wird gelesen, der PUT geht hinaus, und bevor seine Antwort da ist,
// wählt jemand ein anderes Ziel. Gebucht wurde danach gegen das Ziel der
// ANFRAGE: die Zeile wurde sauberer Spiegel dort, wo sie niemand mehr haben
// wollte, und das neue Ziel galt nie. Bei Aufgaben räumte der Upload die
// gerade gewählten Zielspalten sogar ab.
//
// Der Wechsel passiert in `duringPut`, also zwischen Anfrage und Antwort. Er
// schreibt, was die Route für eine lokale Zeile schreibt: nur die Zielspalten.

function secondAccount() {
  return Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Zweites', ?, 'u2', 'p2')
  `).run(dav.url).lastInsertRowid);
}

function addCalendar(slug, forAccount = accountId) {
  const url = dav.addCollection(slug, { name: slug, components: ['VEVENT'] });
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, ?, '#4A90E2', 1)
  `).run(forAccount, url, slug);
  return url;
}

function addTaskList(slug, forAccount = accountId) {
  const url = dav.addCollection(slug, { name: slug, components: ['VTODO'] });
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, ?, 'tasks', 1)
  `).run(forAccount, url, slug);
  return url;
}

const setEventTarget = (id, account, url) => db.prepare(
  'UPDATE calendar_events SET target_caldav_account_id = ?, target_caldav_calendar_url = ? WHERE id = ?'
).run(account, url, id);
const setTaskTarget = (id, account, url) => db.prepare(
  'UPDATE tasks SET target_caldav_account_id = ?, target_caldav_list_url = ? WHERE id = ?'
).run(account, url, id);
const eventTombstones = () => db.prepare('SELECT * FROM calendar_pending_deletions').all();
const todoTombstones  = () => db.prepare('SELECT * FROM caldav_todo_pending_deletions').all();

test('Termin: Ziel wechselt während des Uploads in einen anderen Kalender des Kontos - der Umzug ist vorgemerkt und läuft', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = addCalendar('work');
  const id    = way.create(url, 'Zieht um');
  const uid   = ownUid('event', id, db);

  const happened = duringPut(() => setEventTarget(id, accountId, other));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Upload kam nicht im ersten Kalender an - der Fall ist nicht nachgestellt');
  dav.allowAll();

  let now = row(id);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.outbound_move_to, other, 'der Termin gilt als sauberer Spiegel im alten Kalender, das neue Ziel ist nicht vorgemerkt');

  await way.sync();
  await way.push();
  await way.sync();

  now = row(id);
  assert.equal(rows().length, 1);
  assert.equal(now.outbound_move_to, null);
  assert.equal(now.external_object_url, `${other}${uid}.ics`, 'die Zeile zeigt nicht auf das Objekt im neuen Kalender');
  assert.deepEqual(names(other), [`${uid}.ics`], 'der Termin liegt nicht im neuen Kalender');
  assert.deepEqual(names(url), [], 'der Termin liegt weiter im alten Kalender');
  assert.deepEqual(eventTombstones(), []);
});

test('Termin: dasselbe Ziel in anderer Schreibweise während des Uploads - kein Umzug in den eigenen Kalender', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'Bleibt');
  const uid = ownUid('event', id, db);
  assert.ok(url.endsWith('/'));

  // Derselbe Kalender ohne Schlussstrich. Als Umzug gelesen, legte er im
  // "Ziel" an und löschte in der "Quelle" - dasselbe Objekt.
  const happened = duringPut(() => setEventTarget(id, accountId, url.slice(0, -1)));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  dav.allowAll();

  assert.equal(row(id).external_source, 'caldav');
  assert.equal(row(id).outbound_move_to, null, 'dieselbe URL ohne Schlussstrich gilt als anderer Kalender');

  await way.sync();
  await way.push();
  await way.sync();

  assert.equal(rows().length, 1);
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Termin wurde aus seinem eigenen Kalender gelöscht');
  assert.deepEqual(eventTombstones(), []);
});

test('Termin: Ziel wechselt während des Uploads auf "Lokal" - das Objekt wird wieder entfernt, der Termin bleibt lokal', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'Doch lokal');
  const uid = ownUid('event', id, db);

  const happened = duringPut(() => setEventTarget(id, null, null));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Upload kam nicht an - der Fall ist nicht nachgestellt');
  dav.allowAll();

  let now = row(id);
  assert.equal(now.external_source, 'local', 'der Termin wurde Spiegel in einem Kalender, den niemand mehr gewählt hat');
  assert.equal(now.external_calendar_id, null);
  assert.equal(now.caldav_account_id, null);

  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();

  now = row(id);
  assert.equal(rows().length, 1);
  assert.equal(now.external_source, 'local');
  assert.equal(now.title, 'Doch lokal');
  assert.equal(now.target_caldav_account_id, null);
  assert.deepEqual(names(url), [], 'das Objekt liegt weiter auf dem Server');
  assert.deepEqual(eventTombstones(), []);
});

test('Termin: Ziel wechselt während des Uploads auf ein anderes Konto - er liegt am Ende nur dort', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  const theirs = addCalendar('theirs', second);
  const id     = way.create(url, 'Anderes Konto');
  const uid    = ownUid('event', id, db);

  const happened = duringPut(() => setEventTarget(id, second, theirs));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  assert.equal(decodeURIComponent(dav.seen('PUT')[0].path), `${new URL(url).pathname}${uid}.ics`,
    'der erste PUT ging nicht in den Kalender des ersten Kontos - der Fall ist nicht nachgestellt');
  dav.allowAll();

  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einem Termin sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.caldav_account_id, second, 'der Termin gehört dem Konto, das niemand mehr gewählt hat');
  assert.equal(now.external_object_url, `${theirs}${uid}.ics`);
  assert.deepEqual(names(theirs), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'das Objekt im Kalender des ersten Kontos liegt weiter dort');
  assert.deepEqual(eventTombstones(), []);
});

test('Termin: auf "Lokal" gewechselt, das Entfernen scheitert, dann zurück in denselben Kalender - das Objekt bleibt stehen', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'Hin und her');
  const uid = ownUid('event', id, db);

  const happened = duringPut(() => setEventTarget(id, null, null));
  await way.upload();
  assert.ok(happened());
  dav.allowAll();
  assert.equal(row(id).external_source, 'local', 'der Fall ist nicht nachgestellt: der Termin wurde gespiegelt');
  assert.equal(eventTombstones().length, 1, 'der Fall ist nicht nachgestellt: das Entfernen ist nicht vorgemerkt');

  // Der Server gibt das Objekt nicht her; inzwischen wählt der Nutzer den
  // Kalender wieder. Der Upload trifft auf das eigene Objekt (412) und
  // übernimmt es - ab da ist es gewollt.
  dav.refuse({ method: 'DELETE', status: 403 });
  await way.sync();
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Fall ist nicht nachgestellt: das Objekt ist schon fort');
  setEventTarget(id, accountId, url);
  await way.sync();
  assert.equal(row(id).external_source, 'caldav', 'der Termin ging nicht wieder hinauf');
  dav.allowAll();

  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, 'der Termin ist fort oder doppelt');
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.outbound_dirty, 0);
  assert.deepEqual(names(url), [`${uid}.ics`], 'der alte Löschauftrag hat das wieder gewollte Objekt entfernt');
  assert.deepEqual(eventTombstones(), []);
});

test('Aufgabe: Ziel wechselt während des Uploads in eine andere Liste - sie liegt am Ende nur dort', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = addTaskList('todo2');
  const id    = way.create(url, 'Andere Liste');
  const uid   = ownUid('task', id, db);

  const happened = duringPut(() => setTaskTarget(id, accountId, other));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Upload kam nicht in der ersten Liste an - der Fall ist nicht nachgestellt');
  dav.allowAll();

  let now = row(id);
  assert.equal(now.external_source, 'local', 'die Aufgabe wurde Spiegel in der Liste, die niemand mehr gewählt hat');
  assert.equal(now.target_caldav_list_url, other, 'das gerade gewählte Ziel wurde abgeräumt');
  assert.equal(now.target_caldav_account_id, accountId);

  await way.sync();
  await way.push();
  await way.sync();

  now = row(id);
  assert.equal(rows().length, 1, `aus einer Aufgabe sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.external_object_url, `${other}${uid}.ics`);
  assert.equal(now.target_caldav_list_url, null, 'die gespiegelte Aufgabe trägt weiter ein Upload-Ziel');
  assert.equal(now.target_caldav_account_id, null);
  assert.deepEqual(names(other), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'die Aufgabe liegt weiter in der alten Liste');
  assert.deepEqual(todoTombstones(), []);
});

test('Aufgabe: Ziel wird während des Uploads zurückgenommen - das Objekt wird wieder entfernt, die Aufgabe bleibt lokal', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'Doch lokal');
  const uid = ownUid('task', id, db);

  const happened = duringPut(() => setTaskTarget(id, null, null));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Upload kam nicht an - der Fall ist nicht nachgestellt');
  dav.allowAll();

  assert.equal(row(id).external_source, 'local', 'die Aufgabe wurde Spiegel, obwohl sie lokal bleiben sollte');

  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1);
  assert.equal(now.external_source, 'local');
  assert.equal(now.external_uid, null);
  assert.equal(now.title, 'Doch lokal');
  assert.deepEqual(names(url), [], 'das Objekt liegt weiter auf dem Server');
  assert.deepEqual(todoTombstones(), []);
});

test('Aufgabe: Ziel wechselt während des Uploads auf ein anderes Konto - sie liegt am Ende nur dort', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  const theirs = addTaskList('theirs', second);
  const id     = way.create(url, 'Anderes Konto');
  const uid    = ownUid('task', id, db);

  const happened = duringPut(() => setTaskTarget(id, second, theirs));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  dav.allowAll();

  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einer Aufgabe sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.external_account_id, second, 'die Aufgabe gehört dem Konto, das niemand mehr gewählt hat');
  assert.equal(now.external_object_url, `${theirs}${uid}.ics`);
  assert.deepEqual(names(theirs), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'das Objekt in der Liste des ersten Kontos liegt weiter dort');
  assert.deepEqual(todoTombstones(), []);
});

test('Aufgabe: Ziel zurückgenommen, das Entfernen scheitert, dann zurück in dieselbe Liste - der Upload wartet, die Aufgabe liegt am Ende einmal oben', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'Hin und her');
  const uid = ownUid('task', id, db);

  const happened = duringPut(() => setTaskTarget(id, null, null));
  await way.upload();
  assert.ok(happened());
  dav.allowAll();
  assert.equal(row(id).external_source, 'local', 'der Fall ist nicht nachgestellt: die Aufgabe wurde gespiegelt');
  assert.equal(todoTombstones().length, 1, 'der Fall ist nicht nachgestellt: das Entfernen ist nicht vorgemerkt');

  dav.refuse({ method: 'DELETE', status: 403 });
  await way.sync();
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Fall ist nicht nachgestellt: das Objekt ist schon fort');
  setTaskTarget(id, accountId, url);
  // Solange das alte Objekt noch entfernt werden soll, geht die Zeile nicht
  // wieder hinauf: sie träfe auf genau dieses Objekt, übernähme es, und der
  // wartende Auftrag nähme es ihr danach weg.
  await way.upload();
  await way.sync();
  assert.equal(row(id).external_source, 'local', 'die Aufgabe ging hinauf, während ihr altes Objekt noch entfernt werden soll');
  dav.allowAll();

  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, 'die Aufgabe ist fort oder doppelt');
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.outbound_dirty, 0);
  assert.deepEqual(names(url), [`${uid}.ics`], 'die Aufgabe liegt nicht (mehr) auf dem Server');
  assert.match(dav.getObject(url, `${uid}.ics`).data, /SUMMARY:Hin und her/);
  assert.deepEqual(todoTombstones(), []);
});

test('Einkaufsartikel: wandert während des Uploads in eine nicht zugeordnete Liste - das Objekt wird wieder entfernt', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const privateList = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Privat', 1) RETURNING id").get().id;
  const id  = way.create(url, 'Wandert');
  const uid = ownUid('item', id, db);

  const happened = duringPut(() => db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(privateList, id));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Upload kam nicht an - der Fall ist nicht nachgestellt');
  dav.allowAll();

  assert.equal(row(id).external_source, 'local', 'der Artikel einer nicht gespiegelten Liste wurde Spiegel');

  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einem Artikel sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'local');
  assert.equal(now.list_id, privateList);
  assert.deepEqual(names(url), [], 'das Objekt liegt weiter auf dem Server');
  assert.deepEqual(todoTombstones(), []);
});

test('Einkaufsartikel: wandert während des Uploads in eine anders zugeordnete Liste - er liegt am Ende nur dort', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = dav.addCollection('shop2', { name: 'Drogerie', components: ['VTODO'] });
  const otherList = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Drogerie', 1) RETURNING id").get().id;
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'Drogerie', 'shopping', 1, ?)
  `).run(accountId, other, otherList);
  const id  = way.create(url, 'Wandert');
  const uid = ownUid('item', id, db);

  const happened = duringPut(() => db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(otherList, id));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  dav.allowAll();

  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einem Artikel sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.list_id, otherList);
  assert.equal(now.external_object_url, `${other}${uid}.ics`);
  assert.deepEqual(names(other), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'der Artikel liegt weiter in der alten Liste');
  assert.deepEqual(todoTombstones(), []);
});

test('Einkaufsartikel: weggewandert, das Entfernen scheitert, dann zurück in die Liste - der Upload wartet, der Artikel liegt am Ende einmal oben', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const privateList = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Privat', 1) RETURNING id").get().id;
  const id  = way.create(url, 'Hin und her');
  const uid = ownUid('item', id, db);
  const moveTo = (listId) => db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(listId, id);

  const happened = duringPut(() => moveTo(privateList));
  await way.upload();
  assert.ok(happened());
  dav.allowAll();
  assert.equal(row(id).external_source, 'local', 'der Fall ist nicht nachgestellt: der Artikel wurde gespiegelt');
  assert.equal(todoTombstones().length, 1, 'der Fall ist nicht nachgestellt: das Entfernen ist nicht vorgemerkt');

  dav.refuse({ method: 'DELETE', status: 403 });
  await way.sync();
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Fall ist nicht nachgestellt: das Objekt ist schon fort');
  moveTo(way.listId);
  await way.upload();
  await way.sync();
  assert.equal(row(id).external_source, 'local', 'der Artikel ging hinauf, während sein altes Objekt noch entfernt werden soll');
  dav.allowAll();

  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, 'der Artikel ist fort oder doppelt');
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.outbound_dirty, 0);
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Artikel liegt nicht (mehr) auf dem Server');
  assert.deepEqual(todoTombstones(), []);
});

// Dieselbe Frage eine Zeile früher: das Ziel wechselt, während der Upload
// einer ANDEREN Zeile läuft. Die Schleife las ihre Liste davor und ging mit dem
// Ziel von damals hinaus.

test('Aufgabe: Ziel wechselt, bevor sie im selben Lauf an der Reihe ist - sie geht nicht mehr in die alte Liste', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  const theirs = addTaskList('theirs', second);
  const first  = way.create(url, 'Erste');
  const id     = way.create(url, 'Zweite');
  // Eine dritte wartet weiter auf dieses Konto: gefragt wird nach DIESER
  // Zeile, nicht danach, ob überhaupt noch etwas wartet.
  const third  = way.create(url, 'Dritte');
  const uid    = ownUid('task', id, db);

  const happened = duringPut(() => setTaskTarget(id, second, theirs));
  // Nur das erste Konto läuft: was es mit der zweiten Aufgabe tut, ist die Frage.
  const client = await createCalDAVClient({ caldav_url: dav.url, username: 'u', password: 'p' });
  await todoOutbound.processPendingCreations(client, accountId, 'tasks', new Map([[url, { url }]]));
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  dav.allowAll();

  assert.equal(row(first).external_source, 'caldav');
  assert.equal(row(third).external_source, 'caldav');
  const now = row(id);
  assert.equal(now.external_source, 'local', 'die Aufgabe ging über das Konto hinaus, das niemand mehr gewählt hat');
  assert.equal(now.target_caldav_account_id, second, 'das gerade gewählte Ziel wurde abgeräumt');
  assert.equal(now.target_caldav_list_url, theirs);
  assert.ok(!names(url).includes(`${uid}.ics`), 'die Aufgabe liegt in der alten Liste');
  assert.deepEqual(todoTombstones(), [], 'für ein Objekt, das nie angelegt wurde, wartet ein Löschauftrag');
});

test('Einkaufsartikel: wandert, bevor er im selben Lauf an der Reihe ist - er geht nicht mehr in die alte Liste', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const { row, names } = helpers(way);
  const url = way.setup();
  const privateList = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Privat', 1) RETURNING id").get().id;
  const first = way.create(url, 'Erster');
  const id    = way.create(url, 'Zweiter');
  const uid   = ownUid('item', id, db);

  const happened = duringPut(() => db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(privateList, id));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  dav.allowAll();

  assert.equal(row(first).external_source, 'caldav');
  assert.equal(row(id).external_source, 'local', 'der Artikel einer nicht gespiegelten Liste wurde Spiegel');
  assert.equal(dav.seen('PUT').filter((r) => r.path.includes(encodeURIComponent(uid)) || r.path.includes(uid)).length, 0,
    'der Artikel ging noch in die alte Liste hinauf');
  assert.ok(!names(url).includes(`${uid}.ics`));
  assert.deepEqual(todoTombstones(), []);
});

// Zwei Konten führen DENSELBEN Kalender bzw. dieselbe Liste, und das Ziel
// wechselt während des Uploads vom einen auf das andere. Das Objekt von eben
// liegt dann schon dort, wo es hin soll; das zweite Konto übernimmt es, und der
// Löschauftrag des ersten darf es ihm nicht mehr wegnehmen.

test('Termin: Ziel wechselt während des Uploads auf ein anderes Konto mit DEMSELBEN Kalender - das Objekt bleibt stehen', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Familie', '#4A90E2', 1)
  `).run(second, url);
  const id  = way.create(url, 'Geteilter Kalender');
  const uid = ownUid('event', id, db);

  const happened = duringPut(() => setEventTarget(id, second, url));
  await way.upload();
  assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
  dav.allowAll();

  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, 'der Termin ist fort oder doppelt');
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.caldav_account_id, second);
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Löschauftrag des ersten Kontos hat das übernommene Objekt entfernt');
  assert.deepEqual(eventTombstones(), []);
});

// Das zweite Konto kommt auf zwei Wegen an das Objekt: sein Upload trifft
// darauf (412), oder sein Abruf sieht es zuerst und übernimmt es.
for (const via of ['upload', 'sync']) {
  test(`Aufgabe: Ziel wechselt während des Uploads auf ein anderes Konto mit DERSELBEN Liste (${via === 'upload' ? 'Upload trifft auf das Objekt' : 'Abruf übernimmt'}) - das Objekt bleibt stehen`, async () => {
    reset();
    const way = WAYS.Aufgabe;
    const { row, rows, names } = helpers(way);
    const url    = way.setup();
    const second = secondAccount();
    db.prepare(`
      INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
      VALUES (?, ?, 'Erinnerungen', 'tasks', 1)
    `).run(second, url);
    const id  = way.create(url, 'Geteilte Liste');
    const uid = ownUid('task', id, db);

    const happened = duringPut(() => setTaskTarget(id, second, url));
    await way.upload();
    assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
    dav.allowAll();
    assert.equal(todoTombstones().length, 1, 'der Fall ist nicht nachgestellt: das Entfernen ist nicht vorgemerkt');

    // Das erste Konto bekommt sein Objekt nicht gelöscht, bevor das zweite an
    // der Reihe ist.
    dav.refuse({ method: 'DELETE', status: 403 });
    await way[via]();
    assert.equal(row(id).external_account_id, second, 'der Fall ist nicht nachgestellt: das zweite Konto hat nicht übernommen');
    dav.allowAll();

    await way.sync();
    await way.push();
    await way.sync();

    const now = row(id);
    assert.ok(now, 'die Aufgabe ist fort');
    assert.equal(now.external_source, 'caldav');
    assert.equal(now.external_account_id, second);
    assert.deepEqual(names(url), [`${uid}.ics`], 'der Löschauftrag des ersten Kontos hat das übernommene Objekt entfernt');
    assert.deepEqual(todoTombstones(), []);
    // Aufgaben kennen kein "eine Zeile je UID" über Konten hinweg: jedes Konto
    // führt seine eigene Zeile je Eintrag einer geteilten Liste. Das ist älter
    // als dieser Fall und gilt für den Nachbarn genauso.
    const neighbours = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Nachbar'").get().n;
    assert.equal(rows().length, neighbours, 'die Aufgabe steht öfter da als jeder andere Eintrag der Liste');
  });
}

// Derselbe Kalender, zwei Schreibweisen: das erste Konto führt ihn mit, das
// zweite ohne Schlussstrich. Der Löschauftrag des ersten nennt seine
// Schreibweise; wird die Zeile über das zweite Spiegel, muss er trotzdem fallen.
for (const via of ['Buchung', 'Übernahme']) {
  test(`Termin: der Löschauftrag eines Kontos fällt auch bei anderer Schreibweise des Kalenders (${via})`, () => {
    reset();
    const way = WAYS.Termin;
    const url     = way.setup();
    const noSlash = url.slice(0, -1);
    const second  = secondAccount();
    const id  = way.create(url, 'Geteilter Kalender');
    const uid = ownUid('event', id, db);
    const objectUrl = `${url}${uid}.ics`;

    // Wie nach dem Zielwechsel während des Uploads über das erste Konto.
    assert.equal(outbound.queueDeletion({
      source: 'caldav', calendarExternalId: url, eventExternalId: uid, objectUrl, accountId,
    }), true);
    setEventTarget(id, second, noSlash);
    const what = { source: 'caldav', uid, objectUrl, calRefId: way.refId, calendarUrl: noSlash, accountId: second };
    if (via === 'Buchung') {
      const sent = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
      assert.equal(outbound.bookEventUpload(sent, { ...what, adopted: true }), 'mirrored');
    } else {
      assert.equal(outbound.adoptOwnEventUpload({ ...what, isWaitingHere: () => true }), true);
    }
    assert.equal(db.prepare('SELECT caldav_account_id FROM calendar_events WHERE id = ?').get(id).caldav_account_id, second);
    assert.deepEqual(eventTombstones(), [], 'der Auftrag des ersten Kontos wartet weiter auf das übernommene Objekt');
  });
}

test('Aufgabe: das unerreichbare Ziel wird nur abgeräumt, solange es noch das gelesene ist', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const url   = way.setup();
  const other = addTaskList('todo2');
  const id    = way.create(url, 'Ziel wechselt');
  // Zwischen dem Lesen der Zeile und dem Abräumen wählt jemand ein anderes
  // Ziel: die Liste, nach der die Schleife fragt, gibt es nicht, und während
  // sie fragt, steht an der Zeile schon die andere.
  const lists = new Map();
  lists.get = () => { setTaskTarget(id, accountId, other); return undefined; };
  await todoOutbound.processPendingCreations({}, accountId, 'tasks', lists);

  const now = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(now.target_caldav_list_url, other, 'das inzwischen gewählte Ziel wurde abgeräumt');
  assert.equal(now.target_caldav_account_id, accountId);
});

for (const [label, way] of [['Aufgabe', WAYS.Aufgabe], ['Einkaufsartikel', WAYS.Einkaufsartikel]]) {
  test(`${label}: während des Uploads auf anderem Weg Spiegel geworden - die Buchung überschreibt nichts`, async () => {
    reset();
    const { row, names } = helpers(way);
    const url = way.setup();
    const id  = way.create(url, 'Schon gespiegelt');
    const uid = ownUid(way.kind, id, db);

    const happened = duringPut(() => db.prepare(`
      UPDATE ${way.table}
         SET external_source = 'caldav', external_uid = 'theirs@test', external_account_id = ?, external_object_url = ?
       WHERE id = ?
    `).run(accountId, `${url}theirs.ics`, id));
    await way.upload();
    assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
    assert.ok(names(url).includes(`${uid}.ics`), 'der Upload kam nicht an - der Fall ist nicht nachgestellt');
    dav.allowAll();

    const now = row(id);
    assert.equal(now.external_uid, 'theirs@test', 'die Buchung hat eine schon gespiegelte Zeile umgeschrieben');
    assert.equal(now.external_object_url, `${url}theirs.ics`);
  });
}

// ── Der Upload kam an, seine Antwort nicht - und DANN geschieht etwas (#1882) ───
//
// Anders als oben (#1862, #1881) ist die Anfrage hier längst vorbei, wenn an
// der Zeile etwas geschieht: der PUT kam an, die Antwort nicht, die Zeile
// blieb lokal. Wartet sie weiter auf denselben Platz, übernimmt der nächste
// Lauf das Objekt. Wird sie vorher gelöscht oder bekommt sie ein anderes Ziel,
// wusste niemand mehr, dass dort etwas von ihr liegt: der Abruf holte den
// gelöschten Eintrag als neue Zeile zurück bzw. legte eine zweite an.
//
// Gelöscht wird in den Tests, wie die Route löscht: erst vormerken (für eine
// lokale Zeile merkt sie nichts vor), dann die Zeile entfernen.

const uploadAttempts = () => db.prepare('SELECT * FROM caldav_upload_attempts ORDER BY id').all();
const moduleOf = (way) => (way.kind === 'item' ? 'shopping' : 'tasks');

function deleteLikeTheRoute(way, id) {
  const victim = db.prepare(`SELECT * FROM ${way.table} WHERE id = ?`).get(id);
  const queued = way.kind === 'event'
    ? outbound.queueEventDeletion(victim)
    : todoOutbound.queueTodoDeletion(moduleOf(way), victim);
  db.prepare(`DELETE FROM ${way.table} WHERE id = ?`).run(id);
  return queued;
}

/** Zwei Arten, eine Antwort zu verlieren. Gespeichert hat der Server in beiden. */
const LOST = {
  'mit 500 beantwortet':      () => dav.refuse({ method: 'PUT', status: 500, commit: true, once: true }),
  'Verbindung abgerissen':    () => dav.refuse({ method: 'PUT', commit: true, drop: true, once: true }),
};

/** Der Upload, dessen Antwort verloren geht: danach liegt das Objekt oben, die Zeile ist lokal. */
async function uploadWithLostAnswer(way, url, id, lose = LOST['mit 500 beantwortet']) {
  const { row, names } = helpers(way);
  const uid = ownUid(way.kind, id, db);
  lose();
  await way.upload();
  dav.allowAll();
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Server hat das Objekt nicht gespeichert - der Fall ist nicht nachgestellt');
  assert.equal(row(id).external_source, 'local', 'die verlorene Antwort gilt als Erfolg - der Fall ist nicht nachgestellt');
  return uid;
}

/** Als läge der letzte Versuch länger zurück als die Frist, in der ein später PUT noch ankommen kann. */
const letNotesExpire = () => db.prepare(
  "UPDATE caldav_upload_attempts SET created_at = '2020-01-01T00:00:00Z'"
).run();

const noBookkeepingLeft = () => {
  assert.deepEqual(eventTombstones(), [], 'ein Löschauftrag für Termine ist liegen geblieben');
  assert.deepEqual(todoTombstones(), [], 'ein Löschauftrag für Aufgaben/Einkauf ist liegen geblieben');
  assert.deepEqual(uploadAttempts(), [], 'eine Upload-Notiz ist liegen geblieben');
};

const deletesOf = (uid) => dav.seen('DELETE').filter((r) => decodeURIComponent(r.path).endsWith(`/${uid}.ics`));

for (const [label, way] of Object.entries(WAYS)) {
  const { row, rows, names } = helpers(way);

  for (const [how, lose] of Object.entries(LOST)) {
    test(`${label}: gespeichert, ${how}, dann gelöscht - der Eintrag kommt nicht zurück und verschwindet vom Server`, async () => {
      reset();
      const url = way.setup();
      const id  = way.create(url, 'Wird gelöscht');
      await uploadWithLostAnswer(way, url, id, lose);

      assert.equal(deleteLikeTheRoute(way, id), false,
        'die Route hat für eine lokale Zeile etwas vorgemerkt - der Fall ist ein anderer');

      await way.sync();
      assert.equal(rows().length, 0, 'der gelöschte Eintrag ist nach dem Abruf zurück');
      await way.push();
      await way.sync();

      assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
      assert.deepEqual(names(url), [], 'das Objekt des gelöschten Eintrags liegt weiter auf dem Server');
      noBookkeepingLeft();
    });
  }

  test(`${label}: Antwort verloren, erst NACH dem nächsten Lauf gelöscht - die Löschung geht wie jede andere hinaus`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird später gelöscht');
    const uid = await uploadWithLostAnswer(way, url, id);

    // Der Lauf dazwischen übernimmt das Objekt: die Zeile ist danach Spiegel.
    await way.sync();
    assert.equal(row(id).external_source, way.source, 'der Lauf hat das eigene Objekt nicht übernommen');
    assert.equal(row(id)[way.uidColumn], uid);
    assert.deepEqual(uploadAttempts(), [], 'die Notiz hat die Übernahme überlebt');
    assert.equal(deletesOf(uid).length, 0, 'das Objekt einer wartenden Zeile wurde gelöscht statt übernommen');

    assert.equal(deleteLikeTheRoute(way, id), true, 'für den Spiegel wurde keine Löschung vorgemerkt');
    await way.push();
    await way.sync();

    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    assert.deepEqual(names(url), [], 'das Objekt des gelöschten Eintrags liegt weiter auf dem Server');
    noBookkeepingLeft();
  });

  // Wer in Yuvomi löscht, will den Eintrag fort haben, gleich in welchem Stand
  // er oben liegt - dieselbe Regel wie für jeden gespiegelten Eintrag (#1883:
  // der Auftrag der Löschroute trägt keine Bedingung). Blind ist das DELETE
  // trotzdem nicht: es geht erst nach einem Abruf hinaus, an das Objekt, das
  // dieser Abruf unter der eigenen UID gesehen hat, mit dessen ETag.
  test(`${label}: Antwort verloren, von einer anderen App geändert, dann gelöscht - die Löschung gilt, mit dem gelesenen Stand als Bedingung`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    const uid = await uploadWithLostAnswer(way, url, id);

    const changed = dav.putObject(url, `${uid}.ics`, ics(way.component, uid, 'Von der anderen App'));
    deleteLikeTheRoute(way, id);

    await way.sync();
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist mit dem Stand der anderen App zurück');
    await way.push();
    await way.sync();

    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    assert.deepEqual(names(url), [], 'das Objekt des gelöschten Eintrags liegt weiter auf dem Server');
    const sent = deletesOf(uid);
    assert.ok(sent.length >= 1, 'es ging kein DELETE hinaus');
    assert.deepEqual(sent.map((r) => r.headers['if-match']), sent.map(() => changed.etag),
      'das DELETE ging ohne den gelesenen Stand als Bedingung hinaus');
    noBookkeepingLeft();
  });

  test(`${label}: Antwort verloren, gelöscht, und das Objekt ändert sich zwischen Abruf und DELETE - nicht blind gelöscht, der nächste Lauf holt nach`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    const uid = await uploadWithLostAnswer(way, url, id);
    deleteLikeTheRoute(way, id);

    // Die andere App schreibt, während das DELETE unterwegs ist.
    let raced = false;
    dav.refuse({
      method: 'DELETE', status: 500,
      when: () => {
        if (!raced) { raced = true; dav.putObject(url, `${uid}.ics`, ics(way.component, uid, 'Gerade geändert')); }
        return false;
      },
    });
    await way.sync();
    await way.push();
    assert.ok(raced, 'es lief kein DELETE - der Fall ist nicht nachgestellt');
    assert.equal(deletesOf(uid)[0].status, 412, 'das DELETE hat einen Stand gelöscht, den niemand gelesen hat');
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück, solange sein Löschen wartet');

    await way.sync();
    await way.push();
    await way.sync();
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    assert.deepEqual(names(url), [], 'das Objekt des gelöschten Eintrags liegt weiter auf dem Server');
    noBookkeepingLeft();
  });

  test(`${label}: gelöscht, WÄHREND der nächste Lauf den Server liest - der Eintrag wird nicht importiert`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    await uploadWithLostAnswer(way, url, id);

    // Der Lauf hat begonnen und fragt gerade die Objekte ab; die Zeile ist
    // beim Beginn noch da und fällt, bevor ihr Objekt verarbeitet wird.
    let deleted = false;
    dav.refuse({
      method: 'REPORT', status: 500,
      when: () => { if (!deleted) { deleted = true; deleteLikeTheRoute(way, id); } return false; },
    });
    await way.sync();
    assert.ok(deleted, 'es lief kein Abruf - der Fall ist nicht nachgestellt');
    dav.allowAll();
    assert.equal(rows().length, 0, 'der gelöschte Eintrag wurde im selben Lauf importiert');

    await way.push();
    await way.sync();
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    assert.deepEqual(names(url), [], 'das Objekt des gelöschten Eintrags liegt weiter auf dem Server');
    noBookkeepingLeft();
  });

  test(`${label}: der Upload wurde ABGELEHNT, dann gelöscht - nichts kommt zurück, nichts bleibt liegen`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Nie oben');
    dav.refuse({ method: 'PUT', status: 403, once: true });
    await way.upload();
    dav.allowAll();
    assert.deepEqual(names(url), [], 'der abgelehnte Upload liegt auf dem Server - der Fall ist nicht nachgestellt');
    assert.equal(row(id).external_source, 'local');

    deleteLikeTheRoute(way, id);
    await runAll(way);

    assert.equal(rows().length, 0);
    assert.deepEqual(names(url), []);
    assert.equal(dav.seen('DELETE').length, 0, 'ohne ein Objekt an der Adresse ging ein DELETE hinaus');
    assert.deepEqual(eventTombstones(), []);
    assert.deepEqual(todoTombstones(), []);
    // Die Notiz bleibt die Frist lang stehen (ein später PUT kann noch
    // ankommen) und fällt danach ohne Anfrage.
    assert.equal(uploadAttempts().length, 1, 'die Notiz ist gefallen, bevor ein später PUT ausgeschlossen ist');
    letNotesExpire();
    await runAll(way);
    assert.equal(dav.seen('DELETE').length, 0);
    noBookkeepingLeft();
  });

  test(`${label}: am eigenen Namen liegt ein FREMDES Objekt, der Eintrag wird gelöscht - das fremde Objekt bleibt`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Geheim');
    const uid = ownUid(way.kind, id, db);
    dav.putObject(url, `${uid}.ics`, ics(way.component, 'somebody-else@test', 'Fremd'));

    await way.blindUpload();
    assert.ok(dav.seen('PUT').some((r) => r.status === 412), 'der Upload traf nicht auf das Objekt - der Fall ist nicht nachgestellt');
    assert.equal(row(id).external_source, 'local');

    deleteLikeTheRoute(way, id);
    await runAll(way);

    assert.match(dav.getObject(url, `${uid}.ics`)?.data ?? '', /UID:somebody-else@test/, 'das fremde Objekt wurde gelöscht');
    assert.equal(deletesOf(uid).length, 0, 'an die Adresse des fremden Objekts ging ein DELETE');
    noBookkeepingLeft();
  });

  // Ohne Notiz belegt lokal nichts, dass diese Installation das Objekt dorthin
  // geschickt hat. Die UID allein reicht nicht: sie kommt vom Server, und nach
  // dem Einspielen eines älteren Backups zeigt sie auf Zeilen, die es (noch)
  // nicht wieder gibt.
  test(`${label}: ein Objekt mit eigener UID, zu dem es weder Zeile noch Notiz gibt, wird importiert und nicht gelöscht`, async () => {
    reset();
    const url = way.setup();
    const uid = ownUid(way.kind, 987654, db);
    dav.putObject(url, `${uid}.ics`, ics(way.component, uid, 'Aus der Zeit nach dem Backup'));

    await runAll(way);

    assert.match(dav.getObject(url, `${uid}.ics`)?.data ?? '', /SUMMARY:Aus der Zeit nach dem Backup/, 'das Objekt wurde gelöscht');
    assert.equal(deletesOf(uid).length, 0);
    assert.deepEqual(rows().map((r) => r[way.titleColumn]), ['Aus der Zeit nach dem Backup'],
      'das Objekt wurde nicht als gewöhnlicher Eintrag importiert');
    noBookkeepingLeft();
  });

  test(`${label}: ein geglückter Upload hinterlässt keine Notiz`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Geht durch');
    await way.upload();
    assert.equal(row(id).external_source, way.source, 'der Upload ging nicht durch - der Fall ist nicht nachgestellt');
    assert.deepEqual(uploadAttempts(), []);
  });
}

// ── Antwort verloren UND Ziel gewechselt (#1882, Geschwisterfall zu #1881) ──────
//
// Das Objekt liegt am alten Platz, die Zeile ist lokal und will woandershin.
// Der Abruf erkannte das eigene Objekt nicht als ihres (sie wartet dort nicht
// mehr) und importierte es als ZWEITE Zeile.

test('Termin: Antwort verloren, dann Ziel in einen anderen Kalender des Kontos - er liegt am Ende nur dort, einmal', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = addCalendar('other');
  const id    = way.create(url, 'Zieht um');
  const uid   = await uploadWithLostAnswer(way, url, id);

  setEventTarget(id, accountId, other);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einem Termin sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.external_object_url, `${other}${uid}.ics`);
  assert.equal(now.title, 'Zieht um');
  assert.deepEqual(names(other), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'das Objekt liegt weiter im alten Kalender');
  noBookkeepingLeft();
});

test('Termin: Antwort verloren, dann Ziel auf "Lokal" - das Objekt wird entfernt, der Termin bleibt einmal und lokal', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'Doch lokal');
  await uploadWithLostAnswer(way, url, id);

  setEventTarget(id, null, null);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();

  assert.equal(rows().length, 1);
  assert.equal(row(id).external_source, 'local');
  assert.equal(row(id).title, 'Doch lokal');
  assert.deepEqual(names(url), [], 'das Objekt liegt weiter auf dem Server');
  noBookkeepingLeft();
});

test('Termin: Antwort verloren, dann Ziel auf ein anderes Konto - er liegt am Ende nur dort, einmal', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  const theirs = addCalendar('theirs', second);
  const id     = way.create(url, 'Anderes Konto');
  const uid    = await uploadWithLostAnswer(way, url, id);

  setEventTarget(id, second, theirs);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einem Termin sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.caldav_account_id, second);
  assert.equal(now.external_object_url, `${theirs}${uid}.ics`);
  assert.deepEqual(names(theirs), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'das Objekt im Kalender des ersten Kontos liegt weiter dort');
  noBookkeepingLeft();
});

test('Termin: Antwort verloren, dann Ziel auf ein anderes Konto mit DEMSELBEN Kalender - eine Zeile, ein Objekt, beim neuen Konto', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Familie', '#4A90E2', 1)
  `).run(second, url);
  const id  = way.create(url, 'Geteilter Kalender');
  const uid = await uploadWithLostAnswer(way, url, id);

  setEventTarget(id, second, url);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einem Termin sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.caldav_account_id, second, 'der Termin gehört dem Konto, das niemand mehr gewählt hat');
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Termin liegt nicht (genau einmal) im Kalender');
  noBookkeepingLeft();
});

test('Termin: Antwort verloren, Ziel gewechselt und wieder zurück - der Lauf übernimmt das Objekt wie ohne Wechsel', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = addCalendar('other');
  const id    = way.create(url, 'Hin und zurück');
  const uid   = await uploadWithLostAnswer(way, url, id);

  setEventTarget(id, accountId, other);
  setEventTarget(id, accountId, url);
  await runAll(way);

  assert.equal(rows().length, 1);
  assert.equal(row(id).external_object_url, `${url}${uid}.ics`);
  assert.deepEqual(names(url), [`${uid}.ics`]);
  assert.deepEqual(names(other), []);
  assert.equal(deletesOf(uid).length, 0, 'das Objekt wurde gelöscht und neu angelegt statt übernommen');
  noBookkeepingLeft();
});

test('Aufgabe: Antwort verloren, dann Ziel in eine andere Liste - sie liegt am Ende nur dort, einmal', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = addTaskList('todo2');
  const id    = way.create(url, 'Zieht um');
  const uid   = await uploadWithLostAnswer(way, url, id);

  setTaskTarget(id, accountId, other);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einer Aufgabe sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.external_object_url, `${other}${uid}.ics`);
  assert.equal(now.title, 'Zieht um');
  assert.deepEqual(names(other), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'die Aufgabe liegt weiter in der alten Liste');
  noBookkeepingLeft();
});

test('Aufgabe: Antwort verloren, Ziel in eine andere Liste, und der Sofortversuch kommt vor dem Lauf - er räumt selbst ab', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = addTaskList('todo2');
  const id    = way.create(url, 'Zieht um');
  const uid   = await uploadWithLostAnswer(way, url, id);

  setTaskTarget(id, accountId, other);
  // Erst fort, dann neu, und beides ohne auf den Lauf zu warten: der
  // Sofortversuch räumt den Rest selbst ab, bevor er die Aufgabe hinaufschickt.
  await way.push();
  assert.deepEqual(names(url), [], 'der Sofortversuch hat den Rest in der alten Liste nicht entfernt');
  assert.deepEqual(names(other), [`${uid}.ics`], 'der Sofortversuch hat die Aufgabe nicht in die neue Liste gebracht');
  await way.sync();

  assert.equal(rows().length, 1, `aus einer Aufgabe sind ${rows().length} Zeilen geworden`);
  assert.equal(row(id).external_object_url, `${other}${uid}.ics`);
  assert.deepEqual(names(other), [`${uid}.ics`]);
  assert.deepEqual(names(url), []);
  noBookkeepingLeft();
});

test('Aufgabe: Antwort verloren, dann Ziel zurückgenommen - das Objekt wird entfernt, die Aufgabe bleibt einmal und lokal', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'Doch lokal');
  await uploadWithLostAnswer(way, url, id);

  setTaskTarget(id, null, null);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();

  assert.equal(rows().length, 1);
  assert.equal(row(id).external_source, 'local');
  assert.equal(row(id).title, 'Doch lokal');
  assert.deepEqual(names(url), [], 'das Objekt liegt weiter auf dem Server');
  noBookkeepingLeft();
});

test('Aufgabe: Antwort verloren, dann Ziel auf ein anderes Konto - sie liegt am Ende nur dort, einmal', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  const theirs = addTaskList('theirs', second);
  const id     = way.create(url, 'Anderes Konto');
  const uid    = await uploadWithLostAnswer(way, url, id);

  setTaskTarget(id, second, theirs);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einer Aufgabe sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.external_account_id, second);
  assert.equal(now.external_object_url, `${theirs}${uid}.ics`);
  assert.deepEqual(names(theirs), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'die Aufgabe liegt weiter in der Liste des ersten Kontos');
  noBookkeepingLeft();
});

test('Einkaufsartikel: Antwort verloren, dann in eine nicht zugeordnete Liste - das Objekt wird entfernt, der Artikel bleibt einmal', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const privateList = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Privat', 1) RETURNING id").get().id;
  const id  = way.create(url, 'Wandert');
  await uploadWithLostAnswer(way, url, id);

  db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(privateList, id);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweiten Artikel importiert');
  await way.push();
  await way.sync();

  assert.equal(rows().length, 1);
  assert.equal(row(id).external_source, 'local');
  assert.equal(row(id).list_id, privateList);
  assert.deepEqual(names(url), [], 'das Objekt liegt weiter auf dem Server');
  noBookkeepingLeft();
});

test('Einkaufsartikel: Antwort verloren, dann in eine anders zugeordnete Liste - er liegt am Ende nur dort, einmal', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = dav.addCollection('shop2', { name: 'Drogerie', components: ['VTODO'] });
  const otherList = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Drogerie', 1) RETURNING id").get().id;
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'Drogerie', 'shopping', 1, ?)
  `).run(accountId, other, otherList);
  const id  = way.create(url, 'Wandert');
  const uid = await uploadWithLostAnswer(way, url, id);

  db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(otherList, id);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweiten Artikel importiert');
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, `aus einem Artikel sind ${rows().length} Zeilen geworden`);
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.list_id, otherList);
  assert.equal(now.external_object_url, `${other}${uid}.ics`);
  assert.deepEqual(names(other), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'der Artikel liegt weiter in der alten Liste');
  noBookkeepingLeft();
});

test('iCloud-Termin: Antwort verloren, dann wartet er nicht mehr auf den Upload - das Objekt wird entfernt, der Termin bleibt einmal', async () => {
  reset();
  const way = WAYS['iCloud-Termin'];
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'Serie mit Ausnahme');
  await uploadWithLostAnswer(way, url, id);

  // iCloud lädt keinen Termin hoch, an dem ein Einzelvorkommen hängt.
  db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by, external_source, recurrence_parent_id)
    VALUES ('Nachbar', '2035-03-17T09:00', '2035-03-17T10:00', 0, 1, 'local', ?)
  `).run(id);
  await way.sync();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  await way.push();
  await way.sync();

  assert.equal(rows().length, 1);
  assert.equal(row(id).external_source, 'local');
  assert.deepEqual(names(url), [], 'das Objekt liegt weiter auf dem Server');
  noBookkeepingLeft();
});

test('Aufgabe: Antwort verloren, und das Ziel wechselt, WÄHREND der nächste Lauf liest - sie geht erst hinauf, wenn der Rest fort ist', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = addTaskList('todo2');
  const id    = way.create(url, 'Zieht um');
  const uid   = await uploadWithLostAnswer(way, url, id);

  // Zu Beginn des Laufs wartet die Aufgabe noch auf die alte Liste; das Ziel
  // wechselt, während er die Objekte abfragt.
  let switched = false;
  dav.refuse({
    method: 'REPORT', status: 500,
    when: () => { if (!switched) { switched = true; setTaskTarget(id, accountId, other); } return false; },
  });
  await way.sync();
  assert.ok(switched, 'es lief kein Abruf - der Fall ist nicht nachgestellt');
  dav.allowAll();
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  assert.ok(!(names(url).length && names(other).length), 'die Aufgabe liegt in beiden Listen des Kontos zugleich');

  await way.sync();
  await way.push();
  await way.sync();

  assert.equal(rows().length, 1, `aus einer Aufgabe sind ${rows().length} Zeilen geworden`);
  assert.equal(row(id).external_object_url, `${other}${uid}.ics`);
  assert.deepEqual(names(other), [`${uid}.ics`]);
  assert.deepEqual(names(url), []);
  noBookkeepingLeft();
});

// Die Notiz fällt mit JEDER Buchung, nicht erst beim nächsten Aufräumen.
for (const [label, way] of Object.entries(WAYS)) {
  test(`${label}: gelöscht, während der Upload läuft - gebucht ist ein Löschauftrag und keine Notiz mehr`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    const happened = duringPut(() => db.prepare(`DELETE FROM ${way.table} WHERE id = ?`).run(id));
    await way.upload();
    assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
    dav.allowAll();
    assert.equal(eventTombstones().length + todoTombstones().length, 1, 'der Fall ist nicht nachgestellt: kein Löschauftrag');
    assert.deepEqual(uploadAttempts(), [], 'die Notiz hat die Buchung überlebt');
  });
}

for (const [label, way, release] of [
  ['Termin', WAYS.Termin, (id) => setEventTarget(id, null, null)],
  ['Aufgabe', WAYS.Aufgabe, (id) => setTaskTarget(id, null, null)],
]) {
  test(`${label}: Ziel während des Uploads zurückgenommen - gebucht ist ein Löschauftrag und keine Notiz mehr`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Doch lokal');
    const happened = duringPut(() => release(id));
    await way.upload();
    assert.ok(happened(), 'es lief kein PUT - der Fall ist nicht nachgestellt');
    dav.allowAll();
    assert.equal(eventTombstones().length + todoTombstones().length, 1, 'der Fall ist nicht nachgestellt: kein Löschauftrag');
    assert.deepEqual(uploadAttempts(), [], 'die Notiz hat die Buchung überlebt');
  });
}

// Zwei Konten führen denselben Kalender bzw. dieselbe Liste. Die Antwort geht
// dem ZWEITEN verloren, dann wechselt das Ziel auf das erste: dessen Lauf
// kommt zuerst und übernimmt das Objekt. Die Notiz des zweiten Kontos zeigt
// danach auf ein Objekt, das der Zeile gehört - es darf nicht fallen.
test('Termin: Antwort verloren, ein anderes Konto mit DEMSELBEN Kalender übernimmt zuerst - die Notiz löscht ihm das Objekt nicht weg', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Familie', '#4A90E2', 1)
  `).run(second, url);
  const id  = way.create(url, 'Geteilter Kalender');
  setEventTarget(id, second, url);
  const uid = await uploadWithLostAnswer(way, url, id);
  assert.equal(uploadAttempts()[0]?.account_id, second, 'der Fall ist nicht nachgestellt: der Upload lief nicht über das zweite Konto');

  setEventTarget(id, accountId, url);
  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.equal(rows().length, 1, 'der Termin ist fort oder doppelt');
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.caldav_account_id, accountId);
  assert.deepEqual(names(url), [`${uid}.ics`]);
  assert.equal(deletesOf(uid).length, 0, 'die Notiz des zweiten Kontos hat das übernommene Objekt gelöscht');
  noBookkeepingLeft();
});

test('Aufgabe: Antwort verloren, ein anderes Konto mit DERSELBEN Liste übernimmt zuerst - die Notiz löscht ihm das Objekt nicht weg', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'Erinnerungen', 'tasks', 1)
  `).run(second, url);
  const id  = way.create(url, 'Geteilte Liste');
  setTaskTarget(id, second, url);
  const uid = await uploadWithLostAnswer(way, url, id);
  assert.equal(uploadAttempts()[0]?.account_id, second, 'der Fall ist nicht nachgestellt: der Upload lief nicht über das zweite Konto');

  setTaskTarget(id, accountId, url);
  await way.sync();
  await way.push();
  await way.sync();

  const now = row(id);
  assert.ok(now, 'die Aufgabe ist fort');
  assert.equal(now.external_source, 'caldav');
  assert.equal(now.external_account_id, accountId);
  assert.deepEqual(names(url), [`${uid}.ics`]);
  assert.equal(deletesOf(uid).length, 0, 'die Notiz des zweiten Kontos hat das übernommene Objekt gelöscht');
  noBookkeepingLeft();
});

// Abgeschaltet heisst "nicht mehr abgleichen", nicht "auf dem Server aufräumen":
// das Ziel der Zeile steht weiter, also bleibt auch die Notiz, und nichts wird
// gelöscht. Wieder eingeschaltet, übernimmt der Lauf das Objekt.
test('Termin: Antwort verloren, Kalender abgewählt - nichts wird gelöscht; wieder eingeschaltet übernimmt der Lauf', async () => {
  reset();
  const way = WAYS.Termin;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  addCalendar('other');
  const id  = way.create(url, 'Wartet');
  const uid = await uploadWithLostAnswer(way, url, id);

  const enable = (on) => db.prepare(
    'UPDATE caldav_calendar_selection SET enabled = ? WHERE account_id = ? AND calendar_url = ?'
  ).run(on, accountId, url);
  enable(0);
  await runAll(way);
  assert.deepEqual(names(url), [`${uid}.ics`], 'das Objekt im abgewählten Kalender wurde entfernt');
  assert.equal(deletesOf(uid).length, 0);
  assert.equal(row(id).external_source, 'local');
  assert.equal(uploadAttempts().length, 1, 'die Notiz ist gefallen, obwohl die Zeile weiter dorthin will');

  enable(1);
  await runAll(way);
  assert.equal(rows().length, 1);
  assert.equal(row(id).external_object_url, `${url}${uid}.ics`);
  assert.deepEqual(names(url), [`${uid}.ics`]);
  assert.equal(deletesOf(uid).length, 0, 'das Objekt wurde gelöscht und neu angelegt statt übernommen');
  noBookkeepingLeft();
});

test('Einkaufsartikel: Antwort verloren, Zuordnung abgeschaltet - nichts wird gelöscht; wieder eingeschaltet übernimmt der Lauf', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  // Eine zweite, eingeschaltete Liste: sonst überspringt der Lauf das Konto ganz.
  addTaskList('todo-other');
  const id  = way.create(url, 'Wartet');
  const uid = await uploadWithLostAnswer(way, url, id);

  const enable = (on) => db.prepare(
    'UPDATE caldav_reminder_selection SET enabled = ? WHERE account_id = ? AND list_url = ?'
  ).run(on, accountId, url);
  enable(0);
  await runAll(way);
  assert.deepEqual(names(url), [`${uid}.ics`], 'das Objekt in der abgeschalteten Liste wurde entfernt');
  assert.equal(deletesOf(uid).length, 0);
  assert.equal(row(id).external_source, 'local');
  assert.equal(uploadAttempts().length, 1, 'die Notiz ist gefallen, obwohl der Artikel weiter dorthin gehört');

  enable(1);
  await runAll(way);
  assert.equal(rows().length, 1);
  assert.equal(row(id).external_object_url, `${url}${uid}.ics`);
  assert.deepEqual(names(url), [`${uid}.ics`]);
  assert.equal(deletesOf(uid).length, 0, 'das Objekt wurde gelöscht und neu angelegt statt übernommen');
  noBookkeepingLeft();
});

// Der Lauf allein genügt: ohne einen Sofortversuch dazwischen merkt er den
// Rest selbst vor und entfernt ihn.
for (const [label, way] of Object.entries(WAYS)) {
  const { rows, names } = helpers(way);
  test(`${label}: Antwort verloren, gelöscht, und es folgen nur Läufe - der Lauf räumt selbst ab`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    await uploadWithLostAnswer(way, url, id);
    deleteLikeTheRoute(way, id);

    await way.sync();
    await way.sync();

    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    assert.deepEqual(names(url), [], 'das Objekt des gelöschten Eintrags liegt weiter auf dem Server');
    noBookkeepingLeft();
  });
}

test('adoptOwnEventUpload: die Übernahme bucht - die Notiz des Uploads fällt mit ihr', () => {
  reset();
  const way = WAYS.Termin;
  const url = way.setup();
  const id  = way.create(url, 'Wartet');
  const uid = ownUid('event', id, db);
  db.prepare(`
    INSERT INTO caldav_upload_attempts (source, account_id, kind, row_id, collection_url, uid, object_url)
    VALUES ('caldav', ?, 'event', ?, ?, ?, ?)
  `).run(accountId, id, url, uid, `${url}${uid}.ics`);

  assert.equal(outbound.adoptOwnEventUpload({
    source: 'caldav', uid, objectUrl: `${url}${uid}.ics`, calendarUrl: url, calRefId: way.refId,
    accountId, isWaitingHere: () => true,
  }), true, 'der Fall ist nicht nachgestellt: nicht übernommen');
  assert.deepEqual(uploadAttempts(), [], 'die Notiz hat die Übernahme überlebt');
});

// ── Befunde der Durchsicht von #1895 ────────────────────────────────────────────

test('Aufgabe: Antwort verloren, Liste abgewählt - nichts wird gelöscht; wieder eingeschaltet übernimmt der Lauf', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, rows, names } = helpers(way);
  const url = way.setup();
  // Eine zweite, eingeschaltete Liste: sonst überspringt der Lauf das Konto ganz.
  addTaskList('todo-other');
  const id  = way.create(url, 'Wartet');
  const uid = await uploadWithLostAnswer(way, url, id);

  const enable = (on) => db.prepare(
    'UPDATE caldav_reminder_selection SET enabled = ? WHERE account_id = ? AND list_url = ?'
  ).run(on, accountId, url);
  enable(0);
  await runAll(way);
  await runAll(way);
  assert.deepEqual(names(url), [`${uid}.ics`], 'das Objekt in der abgewählten Liste wurde entfernt');
  assert.equal(deletesOf(uid).length, 0);
  assert.equal(row(id).external_source, 'local');
  assert.equal(row(id).target_caldav_list_url, url, 'das Ziel einer Aufgabe mit unbestätigtem Upload wurde abgeräumt');
  assert.equal(uploadAttempts().length, 1);

  enable(1);
  await runAll(way);
  assert.equal(rows().length, 1);
  assert.equal(row(id).external_object_url, `${url}${uid}.ics`);
  assert.deepEqual(names(url), [`${uid}.ics`]);
  assert.equal(deletesOf(uid).length, 0, 'das Objekt wurde gelöscht und neu angelegt statt übernommen');
  noBookkeepingLeft();
});

// Zwei Konten führen denselben Kalender bzw. dieselbe Liste, die Notiz gehört
// dem ZWEITEN. Der Lauf nimmt das erste Konto zuerst: es hat keine eigene
// Notiz, darf den Rest aber trotzdem nicht importieren.
test('Termin: Antwort über das zweite Konto verloren, gelöscht - auch das erste Konto mit demselben Kalender importiert ihn nicht', async () => {
  reset();
  const way = WAYS.Termin;
  const { rows, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Familie', '#4A90E2', 1)
  `).run(second, url);
  const id = way.create(url, 'Wird gelöscht');
  setEventTarget(id, second, url);
  await uploadWithLostAnswer(way, url, id);
  assert.equal(uploadAttempts()[0]?.account_id, second, 'der Fall ist nicht nachgestellt: der Upload lief nicht über das zweite Konto');

  deleteLikeTheRoute(way, id);
  await way.sync();
  assert.equal(rows().length, 0, 'das erste Konto hat den gelöschten Termin importiert');
  await way.push();
  await way.sync();

  assert.equal(rows().length, 0, 'der gelöschte Termin ist zurück');
  assert.deepEqual(names(url), [], 'das Objekt des gelöschten Termins liegt weiter auf dem Server');
  noBookkeepingLeft();
});

test('Aufgabe: Antwort über das zweite Konto verloren, gelöscht - auch das erste Konto mit derselben Liste importiert sie nicht', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { rows, names } = helpers(way);
  const url    = way.setup();
  const second = secondAccount();
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'Erinnerungen', 'tasks', 1)
  `).run(second, url);
  const id = way.create(url, 'Wird gelöscht');
  setTaskTarget(id, second, url);
  await uploadWithLostAnswer(way, url, id);
  assert.equal(uploadAttempts()[0]?.account_id, second, 'der Fall ist nicht nachgestellt: der Upload lief nicht über das zweite Konto');

  deleteLikeTheRoute(way, id);
  await way.sync();
  assert.equal(rows().filter((r) => r.title === 'Wird gelöscht').length, 0, 'das erste Konto hat die gelöschte Aufgabe importiert');
  await way.push();
  await way.sync();

  assert.equal(rows().filter((r) => r.title === 'Wird gelöscht').length, 0, 'die gelöschte Aufgabe ist zurück');
  assert.deepEqual(names(url), [], 'das Objekt der gelöschten Aufgabe liegt weiter auf dem Server');
  noBookkeepingLeft();
});

// iCloud lädt in den ERSTEN Kalender der Auflistung, und die sagt keine
// Reihenfolge zu. Steht beim nächsten Lauf ein anderer vorn, will der Termin
// weiter hinauf - sein Objekt im früheren ersten ist kein Rest, solange er
// nirgends sonst angekommen ist.
test('iCloud-Termin: Antwort verloren, die Auflistung nennt einen anderen Kalender zuerst und der lehnt ab - nichts wird gelöscht, nichts verdoppelt', async () => {
  reset();
  const way = WAYS['iCloud-Termin'];
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = dav.addCollection('icloud2', { name: 'Zweiter', components: ['VEVENT'] });
  const id    = way.create(url, 'Wartet');
  const uid   = await uploadWithLostAnswer(way, url, id);

  dav.moveToEnd(url);
  dav.refuse({ method: 'PUT', status: 403, when: (req) => req.path.startsWith(new URL(other).pathname) });
  await runAll(way);

  assert.deepEqual(names(url), [`${uid}.ics`], 'das Objekt wurde gelöscht, obwohl der Termin nirgends sonst angekommen ist');
  assert.equal(deletesOf(uid).length, 0);
  assert.equal(rows().length, 1, 'der Abruf hat das eigene Objekt als zweite Zeile importiert');
  assert.equal(row(id).external_source, 'local');

  // Der andere Kalender nimmt ihn an: er liegt dann dort, und der Rest fällt.
  dav.allowAll();
  await runAll(way);
  assert.equal(rows().length, 1);
  assert.equal(row(id).external_object_url, `${other}${uid}.ics`);
  assert.deepEqual(names(other), [`${uid}.ics`]);
  assert.deepEqual(names(url), [], 'der Rest im früheren ersten Kalender liegt weiter dort');
  noBookkeepingLeft();
});

// Derselbe Kalender über zwei Wege verbunden: die Zeile ist an genau diesem
// Platz Spiegel, nur unter der anderen Quelle. Ihr Objekt ist kein Rest.
test('Termin: Antwort verloren, die Zeile ist inzwischen über iCloud Spiegel am selben Platz - die Notiz löscht das Objekt nicht', async () => {
  reset();
  const way = WAYS.Termin;
  const { names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'Zwei Wege');
  const uid = await uploadWithLostAnswer(way, url, id);

  const appleRef = db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color) VALUES ('apple', ?, 'iCloud', '#4A90E2') RETURNING id
  `).get(url).id;
  db.prepare(`
    UPDATE calendar_events
    SET external_source = 'apple', external_calendar_id = ?, calendar_ref_id = ?, external_object_url = ?,
        target_caldav_account_id = NULL, target_caldav_calendar_url = NULL
    WHERE id = ?
  `).run(uid, appleRef, `${url}${uid}.ics`, id);

  await way.sync();
  await way.sync();
  assert.deepEqual(names(url), [`${uid}.ics`], 'das Objekt, das die Zeile spiegelt, wurde gelöscht');
  assert.equal(deletesOf(uid).length, 0);
  assert.deepEqual(uploadAttempts(), [], 'die Notiz ist stehen geblieben');
  assert.deepEqual(eventTombstones(), []);
});

test('iCloud: beim Trennen der Verbindung fallen ihre Upload-Notizen', async () => {
  reset();
  const way = WAYS['iCloud-Termin'];
  const url = way.setup();
  const id  = way.create(url, 'Wartet');
  await uploadWithLostAnswer(way, url, id);
  assert.equal(uploadAttempts().length, 1, 'der Fall ist nicht nachgestellt: keine Notiz');
  appleCalendar.clearCredentials();
  assert.deepEqual(uploadAttempts(), []);
});

// Fehlt die Tabelle (gedriftete Datenbank), scheitert das Schreiben der Notiz
// laut und nichts geht hinaus. Das Buchen danach darf daran NICHT scheitern:
// die Zeile ist dann schon umgeschrieben.
test('Übernahme ohne Notiztabelle: gebucht wird trotzdem, ohne Fehler', async () => {
  reset();
  const way = WAYS.Termin;
  const url = way.setup();
  const id  = way.create(url, 'Wartet');
  const uid = ownUid('event', id, db);
  db.exec('ALTER TABLE caldav_upload_attempts RENAME TO caldav_upload_attempts_away');
  try {
    assert.equal(outbound.adoptOwnEventUpload({
      source: 'caldav', uid, objectUrl: `${url}${uid}.ics`, calendarUrl: url, calRefId: way.refId,
      accountId, isWaitingHere: () => true,
    }), true);
    assert.equal(await outbound.releaseLeftoverUploads(null, { source: 'caldav', accountId }), 0);
    assert.equal(await todoOutbound.releaseLeftoverTodoUploads(null, accountId), 0);
  } finally {
    db.exec('ALTER TABLE caldav_upload_attempts_away RENAME TO caldav_upload_attempts');
  }
  assert.equal(db.prepare('SELECT external_source FROM calendar_events WHERE id = ?').get(id).external_source, 'caldav');
});

// ── Befunde der ersten Bot-Runde zu #1895 ───────────────────────────────────────

// Der Client hat aufgegeben, der Server verarbeitet den PUT noch. Wird die
// Zeile in der Zwischenzeit gelöscht, liegt beim nächsten Lauf NICHTS oben -
// und danach doch.
for (const [label, way] of Object.entries(WAYS)) {
  const { rows, names } = helpers(way);

  test(`${label}: der PUT wird erst gespeichert, NACHDEM der gelöschte Eintrag schon einen Lauf hinter sich hat - er kommt trotzdem nicht zurück`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    const uid = ownUid(way.kind, id, db);
    let late = null;
    dav.refuse({ method: 'PUT', drop: true, once: true, defer: (run) => { late = run; } });
    await way.upload();
    dav.allowAll();
    assert.ok(late, 'es lief kein PUT - der Fall ist nicht nachgestellt');
    assert.deepEqual(names(url), [], 'der PUT ist schon gespeichert - der Fall ist nicht nachgestellt');

    deleteLikeTheRoute(way, id);
    await way.sync();
    await way.push();
    await way.sync();

    late();
    assert.deepEqual(names(url), [`${uid}.ics`], 'der späte PUT kam nicht an - der Fall ist nicht nachgestellt');
    await way.sync();
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist mit dem späten PUT zurück');
    await way.push();
    await way.sync();
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    assert.deepEqual(names(url), [], 'das Objekt des späten PUT liegt weiter auf dem Server');
    noBookkeepingLeft();
  });

  // Der Upload scheiterte, OHNE etwas zu speichern. Später liegt an derselben
  // Adresse ein Objekt mit anderer UID. Die Notiz belegt nur den Versuch,
  // nicht, was dort heute liegt.
  test(`${label}: Upload abgelehnt, später ein FREMDES Objekt an der Adresse, dann gelöscht - das fremde Objekt bleibt`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Nie oben');
    const uid = ownUid(way.kind, id, db);
    dav.refuse({ method: 'PUT', status: 403, once: true });
    await way.upload();
    dav.allowAll();
    assert.deepEqual(names(url), [], 'der abgelehnte Upload liegt auf dem Server - der Fall ist nicht nachgestellt');
    assert.equal(uploadAttempts().length, 1, 'der Fall ist nicht nachgestellt: keine Notiz');

    dav.putObject(url, `${uid}.ics`, ics(way.component, 'somebody-else@test', 'Fremd'));
    deleteLikeTheRoute(way, id);
    await runAll(way);
    await runAll(way);

    assert.match(dav.getObject(url, `${uid}.ics`)?.data ?? '', /UID:somebody-else@test/, 'das fremde Objekt wurde gelöscht');
    assert.equal(deletesOf(uid).length, 0, 'an die Adresse des fremden Objekts ging ein DELETE');
    assert.deepEqual(uploadAttempts(), [], 'die Notiz zeigt weiter auf das fremde Objekt');
  });
}

test('Konto auf einen anderen Server oder Benutzer umgestellt: seine Upload-Notizen fallen', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const url = way.setup();
  const id  = way.create(url, 'Wartet');
  await uploadWithLostAnswer(way, url, id);
  assert.equal(uploadAttempts().length, 1, 'der Fall ist nicht nachgestellt: keine Notiz');

  await caldavSync.updateAccount(accountId, { username: 'somebody-else', password: 'p' });
  assert.deepEqual(uploadAttempts(), [], 'die Notiz meint ein Objekt des alten Kontos und steht noch');
});

// Die Frist gilt dem späten PUT, nicht dem Löschen: liegt das Objekt oben,
// wird es auch nach Ablauf entfernt - und ein abgelehntes Löschen wird nach
// Ablauf aufgegeben statt für immer wiederholt.
for (const [label, way] of Object.entries(WAYS)) {
  const { rows, names } = helpers(way);

  test(`${label}: Antwort verloren, gelöscht, die Frist ist längst um - das Objekt wird trotzdem entfernt`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    await uploadWithLostAnswer(way, url, id);
    deleteLikeTheRoute(way, id);
    letNotesExpire();

    await way.sync();
    await way.push();
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    assert.deepEqual(names(url), [], 'das Objekt des gelöschten Eintrags liegt weiter auf dem Server');
    noBookkeepingLeft();
  });

  test(`${label}: das Entfernen des Rests wird abgelehnt - wiederholt bis zum Ende der Frist, dann aufgegeben`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    const uid = await uploadWithLostAnswer(way, url, id);
    deleteLikeTheRoute(way, id);

    dav.refuse({ method: 'DELETE', status: 403 });
    await way.sync();
    await way.sync();
    assert.ok(deletesOf(uid).length >= 2, 'das abgelehnte Entfernen wurde nicht wiederholt');
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück, solange sein Entfernen wartet');
    assert.equal(uploadAttempts().length, 1);

    letNotesExpire();
    await way.sync();
    assert.deepEqual(uploadAttempts(), [], 'das Entfernen wird nach Ablauf der Frist weiter versucht');
    assert.deepEqual(names(url), [`${uid}.ics`]);
  });
}

// Zwischen dem Blick auf den Server und dem Löschen liegt eine Anfrage. Wählt
// in der Zeit jemand das alte Ziel wieder, wartet die Zeile dort erneut - ihr
// Objekt ist dann kein Rest mehr.
for (const [label, way, away, back] of [
  ['Termin', WAYS.Termin, (id) => setEventTarget(id, null, null), (id, url) => setEventTarget(id, accountId, url)],
  ['Aufgabe', WAYS.Aufgabe, (id) => setTaskTarget(id, null, null), (id, url) => setTaskTarget(id, accountId, url)],
]) {
  test(`${label}: Ziel zurückgenommen und wieder gewählt, WÄHREND der Rest geprüft wird - nichts wird gelöscht`, async () => {
    reset();
    const { row, rows, names } = helpers(way);
    const url = way.setup();
    const id  = way.create(url, 'Hin und zurück');
    const uid = await uploadWithLostAnswer(way, url, id);

    away(id);
    let probed = false;
    dav.refuse({
      method: 'REPORT', status: 500,
      when: (req) => {
        // Der Abruf des Laufs fragt alle Objekte auf einmal ab, die Prüfung
        // des Rests genau eines.
        const asked = (req.body.match(/<[^/>]*href[^>]*>/g) || []).length;
        if (!probed && /multiget/.test(req.body) && asked === 1) { probed = true; back(id, url); }
        return false;
      },
    });
    await way.sync();
    assert.ok(probed, 'der Rest wurde nicht geprüft - der Fall ist nicht nachgestellt');
    dav.allowAll();
    assert.equal(deletesOf(uid).length, 0, 'das Objekt einer wieder wartenden Zeile wurde gelöscht');
    assert.deepEqual(names(url), [`${uid}.ics`]);

    await runAll(way);
    assert.equal(rows().length, 1);
    assert.equal(row(id).external_object_url, `${url}${uid}.ics`);
    assert.equal(deletesOf(uid).length, 0);
    noBookkeepingLeft();
  });
}

// Entfernt wird nur an Plätzen, die der Durchgang führt: ein abgewählter
// Kalender bzw. eine abgeschaltete Liste bleibt unberührt, auch wenn der
// Eintrag gelöscht ist.
for (const [label, way, table, column, addOther] of [
  ['Termin', WAYS.Termin, 'caldav_calendar_selection', 'calendar_url', () => addCalendar('other')],
  ['Aufgabe', WAYS.Aufgabe, 'caldav_reminder_selection', 'list_url', () => addTaskList('todo-other')],
]) {
  test(`${label}: Antwort verloren, gelöscht, Platz abgeschaltet - dort wird nichts entfernt, bis er wieder eingeschaltet ist`, async () => {
    reset();
    const { rows, names } = helpers(way);
    const url = way.setup();
    addOther();
    const id  = way.create(url, 'Wird gelöscht');
    const uid = await uploadWithLostAnswer(way, url, id);
    deleteLikeTheRoute(way, id);

    const enable = (on) => db.prepare(`UPDATE ${table} SET enabled = ? WHERE account_id = ? AND ${column} = ?`).run(on, accountId, url);
    enable(0);
    await runAll(way);
    assert.deepEqual(names(url), [`${uid}.ics`], 'in einem abgeschalteten Platz wurde ein Objekt entfernt');
    assert.equal(deletesOf(uid).length, 0);
    assert.equal(uploadAttempts().length, 1);

    enable(1);
    await way.sync();
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    await way.push();
    assert.deepEqual(names(url), []);
    noBookkeepingLeft();
  });
}

test('Notiz: jeder neue Versuch setzt ihre Frist neu', async () => {
  reset();
  const way = WAYS.Termin;
  const url = way.setup();
  way.create(url, 'Wird abgelehnt');
  dav.refuse({ method: 'PUT', status: 403 });
  await way.upload();
  letNotesExpire();
  await way.upload();
  assert.equal(uploadAttempts().length, 1);
  assert.notEqual(uploadAttempts()[0].created_at, '2020-01-01T00:00:00Z', 'die Frist zählt weiter ab dem ersten Versuch');
});

test('adoptOwnUpload: die Übernahme bucht - die Notiz des Uploads fällt mit ihr', () => {
  reset();
  const way = WAYS.Aufgabe;
  const url = way.setup();
  const id  = way.create(url, 'Wartet');
  const uid = ownUid('task', id, db);
  db.prepare(`
    INSERT INTO caldav_upload_attempts (source, account_id, kind, row_id, collection_url, uid, object_url)
    VALUES ('caldav', ?, 'task', ?, ?, ?, ?)
  `).run(accountId, id, url, uid, `${url}${uid}.ics`);

  assert.equal(todoOutbound.adoptOwnUpload('tasks', uid, accountId, `${url}${uid}.ics`, { listUrl: url }), true,
    'der Fall ist nicht nachgestellt: nicht übernommen');
  assert.deepEqual(uploadAttempts(), [], 'die Notiz hat die Übernahme überlebt');
});

// ── Befunde der zweiten Bot-Runde zu #1895 ──────────────────────────────────────

// Der übersprungene Rest darf nicht in den Index des Laufs: iCloud führt ihn
// je UID, und der Rest im früheren ersten Kalender verdrängte sonst das Objekt,
// das die Zeile inzwischen spiegelt.
test('iCloud-Termin: der Rest im früheren ersten Kalender liegt noch, die Zeile ist woanders Spiegel und wird bearbeitet - die Bearbeitung geht ohne 412 hinaus', async () => {
  reset();
  const way = WAYS['iCloud-Termin'];
  const { row, names } = helpers(way);
  const url   = way.setup();
  const other = dav.addCollection('icloud2', { name: 'Zweiter', components: ['VEVENT'] });
  const id    = way.create(url, 'Alt');
  const uid   = await uploadWithLostAnswer(way, url, id);

  // Der andere Kalender steht jetzt vorn (und wird zuerst gelesen), der Rest
  // im früheren ersten lässt sich nicht entfernen.
  dav.moveToEnd(url);
  dav.refuse({ method: 'DELETE', status: 403 });
  await runAll(way);
  assert.equal(row(id).external_object_url, `${other}${uid}.ics`, 'der Fall ist nicht nachgestellt: nicht im neuen ersten Kalender gespiegelt');
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Fall ist nicht nachgestellt: der Rest ist fort');

  db.prepare("UPDATE calendar_events SET title = 'Neu', outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?").run(id);
  const before = dav.seen('PUT').length;
  await way.sync();
  const puts = dav.seen('PUT').slice(before);
  assert.deepEqual(puts.map((r) => r.status).filter((status) => status === 412), [], 'die Bearbeitung ging mit dem ETag des Rests hinaus');
  assert.match(dav.getObject(other, `${uid}.ics`).data, /SUMMARY:Neu/, 'die Bearbeitung ist nicht auf dem Server angekommen');
  assert.equal(row(id).outbound_dirty, 0);
});

// Eine Liste wird von "Aufgaben" auf "Einkauf" umgestellt. Die Aufgabe, deren
// Upload dorthin nie bestätigt wurde, wartet dort nicht mehr.
test('Aufgabe: Antwort verloren, die Liste wird auf Einkauf umgestellt - der Rest wird entfernt, nichts wird als Artikel importiert, das Ziel fällt', async () => {
  reset();
  const way = WAYS.Aufgabe;
  const { row, names } = helpers(way);
  const url = way.setup();
  const id  = way.create(url, 'War eine Aufgabe');
  await uploadWithLostAnswer(way, url, id);

  const listId = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Einkauf', 1) RETURNING id").get().id;
  db.prepare(`
    UPDATE caldav_reminder_selection SET target_module = 'shopping', target_list_id = ?
    WHERE account_id = ? AND list_url = ?
  `).run(listId, accountId, url);

  await way.sync();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shopping_items WHERE name = 'War eine Aufgabe'").get().n, 0,
    'das Objekt der Aufgabe wurde als Einkaufsartikel importiert');
  await way.push();
  await way.sync();

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shopping_items WHERE name = 'War eine Aufgabe'").get().n, 0);
  assert.deepEqual(names(url), [], 'der Rest der Aufgabe liegt weiter in der Liste');
  const now = row(id);
  assert.equal(now.external_source, 'local');
  assert.equal(now.target_caldav_list_url, null, 'die Aufgabe hält an einer Liste fest, die keine Aufgaben mehr führt');
  noBookkeepingLeft();
});

// Die Verbindung läuft über die Umgebungsvariablen weiter: dann ist nichts
// getrennt, und die Notizen sind weiter der einzige Beleg.
test('iCloud: Trennen lässt die Upload-Notizen stehen, solange die Verbindung über APPLE_* weiterläuft', async () => {
  reset();
  const way = WAYS['iCloud-Termin'];
  const url = way.setup();
  const id  = way.create(url, 'Wartet');
  await uploadWithLostAnswer(way, url, id);
  const env = ['APPLE_CALDAV_URL', 'APPLE_USERNAME', 'APPLE_APP_SPECIFIC_PASSWORD'];
  const saved = env.map((name) => process.env[name]);
  process.env.APPLE_CALDAV_URL = dav.url;
  process.env.APPLE_USERNAME = 'u';
  process.env.APPLE_APP_SPECIFIC_PASSWORD = 'p';
  try {
    appleCalendar.clearCredentials();
    assert.equal(uploadAttempts().length, 1, 'die Notiz ist gefallen, obwohl die Verbindung weiterläuft');
  } finally {
    env.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
  }
});

// Nennt der Server keinen ETag, geht das DELETE ohne If-Match hinaus. Die
// UID-Prüfung unmittelbar davor trägt auch diesen Fall.
for (const [label, way] of Object.entries(WAYS)) {
  const { rows, names } = helpers(way);

  test(`${label}: der Server nennt keinen ETag, an der Adresse liegt die EIGENE UID - der Rest wird entfernt`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Wird gelöscht');
    const uid = await uploadWithLostAnswer(way, url, id);
    deleteLikeTheRoute(way, id);
    dav.announceEtags(false);

    await runAll(way);
    assert.equal(rows().length, 0, 'der gelöschte Eintrag ist zurück');
    assert.deepEqual(names(url), [], 'der Rest liegt weiter auf dem Server');
    const sent = deletesOf(uid);
    assert.ok(sent.length >= 1 && sent.every((r) => !r.headers['if-match']), 'der Fall ist nicht nachgestellt: das DELETE trug einen ETag');
    assert.deepEqual(uploadAttempts(), []);
  });

  test(`${label}: der Server nennt keinen ETag, an der Adresse liegt eine FREMDE UID - kein DELETE`, async () => {
    reset();
    const url = way.setup();
    const id  = way.create(url, 'Nie oben');
    const uid = ownUid(way.kind, id, db);
    dav.refuse({ method: 'PUT', status: 403, once: true });
    await way.upload();
    dav.allowAll();
    assert.equal(uploadAttempts().length, 1, 'der Fall ist nicht nachgestellt: keine Notiz');
    dav.putObject(url, `${uid}.ics`, ics(way.component, 'somebody-else@test', 'Fremd'));
    deleteLikeTheRoute(way, id);
    dav.announceEtags(false);

    await runAll(way);
    assert.match(dav.getObject(url, `${uid}.ics`)?.data ?? '', /UID:somebody-else@test/, 'das fremde Objekt wurde gelöscht');
    assert.equal(deletesOf(uid).length, 0, 'an die Adresse des fremden Objekts ging ein DELETE');
    assert.deepEqual(uploadAttempts(), []);
  });
}

// ── Der Rest zählt nicht als "der Server liefert den Eintrag noch" (#1905) ───────
//
// Die Zeile ist inzwischen woanders im selben Konto Spiegel, am alten Platz
// liegt noch der Rest des nie bestätigten Uploads. Löscht eine andere App den
// Eintrag am neuen Platz, ist er auf dem Server fort - der übersprungene Rest
// trägt dieselbe UID, wird aber weder importiert noch einer Zeile zugeordnet.
// Zählte er trotzdem als gesehen, bliebe die Zeile einen Lauf länger stehen,
// und so lange der Server das Entfernen des Rests ablehnt: bis zum Ende der
// Frist der Notiz.

/** Entfernt ein Objekt, als hätte es eine andere App gelöscht. */
async function deletedByAnotherApp(collectionUrl, name) {
  const res = await fetch(`${collectionUrl}${name}`, { method: 'DELETE' });
  assert.equal(res.status, 204, 'der Fall ist nicht nachgestellt: das Objekt liess sich nicht löschen');
}

/**
 * Bis hierher für jeden Weg gleich: die Zeile `id` ist Spiegel in `other`, in
 * `url` liegt der Rest mit seiner Notiz, und in `other` liegt ein zweiter
 * Eintrag (sonst antwortet der Leer-Guard des Prune).
 */
function assertMirroredWithLeftover(way, { id, uid, url, other }) {
  const { row, names } = helpers(way);
  assert.equal(row(id).external_source, way.source, 'der Fall ist nicht nachgestellt: die Zeile ist kein Spiegel');
  assert.equal(row(id).external_object_url, `${other}${uid}.ics`, 'der Fall ist nicht nachgestellt: nicht am neuen Platz gespiegelt');
  assert.deepEqual(names(url), [`${uid}.ics`], 'der Fall ist nicht nachgestellt: der Rest ist fort');
  assert.equal(uploadAttempts().length, 1, 'der Fall ist nicht nachgestellt: keine Notiz für den Rest');
  assert.deepEqual(names(other).sort(), ['neighbour2.ics', `${uid}.ics`].sort());
}

const LEFTOVER_CASES = {
  Termin: {
    way: WAYS.Termin,
    async arrange() {
      const way = WAYS.Termin;
      const url   = way.setup();
      const other = addCalendar('other');
      dav.putObject(other, 'neighbour2.ics', ics('VEVENT', 'neighbour2@test', 'Nachbar'));
      const id  = way.create(url, 'Zieht um');
      const uid = await uploadWithLostAnswer(way, url, id);
      // Neues Ziel, und der Upload dorthin kommt vor dem nächsten Abruf. Der
      // Server lässt den Rest so lange nicht entfernen.
      setEventTarget(id, accountId, other);
      dav.refuse({ method: 'DELETE', status: 403 });
      dav.refuse({ method: 'REPORT', status: 503 });
      await way.sync();
      dav.allowAll();
      return { id, uid, url, other };
    },
  },
  'iCloud-Termin': {
    way: WAYS['iCloud-Termin'],
    async arrange() {
      const way = WAYS['iCloud-Termin'];
      const url   = way.setup();
      const other = dav.addCollection('icloud2', { name: 'Zweiter', components: ['VEVENT'] });
      dav.putObject(other, 'neighbour2.ics', ics('VEVENT', 'neighbour2@test', 'Nachbar'));
      const id  = way.create(url, 'Zieht um');
      const uid = await uploadWithLostAnswer(way, url, id);
      // Der andere Kalender steht jetzt vorn: dorthin geht der Upload.
      dav.moveToEnd(url);
      dav.refuse({ method: 'DELETE', status: 403 });
      await runAll(way);
      dav.allowAll();
      return { id, uid, url, other };
    },
  },
  Aufgabe: {
    way: WAYS.Aufgabe,
    async arrange() {
      const way = WAYS.Aufgabe;
      const url   = way.setup();
      const other = addTaskList('todo2');
      dav.putObject(other, 'neighbour2.ics', ics('VTODO', 'neighbour2@test', 'Nachbar'));
      const id  = way.create(url, 'Zieht um');
      const uid = await uploadWithLostAnswer(way, url, id);
      setTaskTarget(id, accountId, other);
      dav.refuse({ method: 'DELETE', status: 403 });
      await way.push();
      dav.allowAll();
      return { id, uid, url, other };
    },
  },
};

for (const [label, { way, arrange }] of Object.entries(LEFTOVER_CASES)) {
  const { rows, names } = helpers(way);

  test(`${label}: woanders gespiegelt und dort von einer anderen App gelöscht, am alten Platz liegt noch der Rest - die Zeile fällt im selben Lauf`, async () => {
    reset();
    const placed = await arrange();
    assertMirroredWithLeftover(way, placed);
    await deletedByAnotherApp(placed.other, `${placed.uid}.ics`);

    await way.sync();
    assert.equal(rows().length, 0, 'die auf dem Server gelöschte Zeile steht noch - der Rest am alten Platz hat sie gehalten');
    assert.deepEqual(names(placed.url), [], 'der Rest liegt weiter am alten Platz');

    await way.sync();
    assert.equal(rows().length, 0, 'der Eintrag ist zurück');
    noBookkeepingLeft();
  });

  test(`${label}: dasselbe, und der Server lehnt das Entfernen des Rests ab - die Zeile fällt trotzdem sofort, der Rest wird nie importiert`, async () => {
    reset();
    const placed = await arrange();
    assertMirroredWithLeftover(way, placed);
    await deletedByAnotherApp(placed.other, `${placed.uid}.ics`);
    dav.refuse({ method: 'DELETE', status: 403 });

    await way.sync();
    assert.equal(rows().length, 0, 'die auf dem Server gelöschte Zeile steht noch, solange der Rest sich nicht entfernen lässt');
    await way.sync();
    assert.equal(rows().length, 0, 'der Rest wurde als Eintrag importiert');
    assert.deepEqual(names(placed.url), [`${placed.uid}.ics`], 'der Fall ist nicht nachgestellt: der Rest wurde entfernt');
    assert.equal(uploadAttempts().length, 1, 'die Notiz ist gefallen, obwohl der Rest noch liegt');
  });
}

// Die eine Ausnahme (#1700): ein Einkaufsartikel, der anderswo Spiegel
// derselben UID ist, geht zu dem Objekt am alten Platz ZURÜCK, wenn seine Kopie
// am neuen fehlt - es ist dann das letzte, das der Server von ihm führt. Das
// entscheidet `confirmCarriedCopy` nach dem Prune; zählte der Rest hier nicht
// als gesehen, räumte der Prune die Zeile vorher ab und der Lauf danach das
// Objekt. Für die Mitnahme selbst steht das in test:shopping-move-carry; hier
// für den Upload, der seinem Ziel gefolgt ist.
test('Einkaufsartikel: woanders gespiegelt und dort von einer anderen App gelöscht, am alten Platz liegt noch der Rest - der Artikel bleibt und geht zu ihm zurück', async () => {
  reset();
  const way = WAYS.Einkaufsartikel;
  const { row, rows, names } = helpers(way);
  const url   = way.setup();
  const other = dav.addCollection('shop2', { name: 'Drogerie', components: ['VTODO'] });
  dav.putObject(other, 'neighbour2.ics', ics('VTODO', 'neighbour2@test', 'Nachbar'));
  const otherList = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Drogerie', 1) RETURNING id").get().id;
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'Drogerie', 'shopping', 1, ?)
  `).run(accountId, other, otherList);
  const id  = way.create(url, 'Wandert');
  const uid = await uploadWithLostAnswer(way, url, id);
  db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(otherList, id);
  dav.refuse({ method: 'DELETE', status: 403 });
  await way.push();
  dav.allowAll();
  assertMirroredWithLeftover(way, { id, uid, url, other });
  await deletedByAnotherApp(other, `${uid}.ics`);

  await way.sync();
  await way.sync();

  assert.equal(rows().length, 1, 'der Artikel ist abgeräumt, obwohl sein letztes Objekt noch auf dem Server liegt');
  assert.deepEqual(names(url), [`${uid}.ics`], 'das letzte Objekt des Artikels wurde entfernt');
  const now = row(id);
  assert.deepEqual([now.external_source, now.external_object_url, now.list_id],
    ['caldav', `${url}${uid}.ics`, way.listId], 'der Artikel steht nicht, wo der Server ihn führt');
  noBookkeepingLeft();
});
