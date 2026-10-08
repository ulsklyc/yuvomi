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
  sqlIsOwnEventUidOfRow, sqlLooksLikeOwnEventUid,
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
