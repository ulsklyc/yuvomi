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
    'calendar_pending_deletions', 'calendar_events', 'external_calendars',
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
           external_calendar_id, calendar_ref_id, external_object_url)
        VALUES (?, '2035-03-10T09:00Z', '2035-03-10T10:00Z', 0, 1, 'caldav', ?, ?, ?)
      `).run(title, uid, this.refId, objectUrl).lastInsertRowid);
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
      'color_modified',
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
    source: 'caldav', uid, objectUrl: `${cal}${uid}.ics`, calendarUrl: cal, calRefId: way.refId,
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
  const encoded = `${collection}${uid.replace('@', '%40')}.ics`;
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
