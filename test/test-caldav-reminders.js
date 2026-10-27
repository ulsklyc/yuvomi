/**
 * Test: CalDAV Reminders Sync (Apple Reminders / VTODO → Tasks & Shopping)
 * Purpose: Verify VTODO field mapping, schema, and read-only upsert logic.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import {
  mapVtodoPriority, splitDue, pruneRemoved, getReminderLists, applyTaskRelations,
} from '../server/services/caldav-reminders-sync.js';
import { parseVTODO } from '../server/services/ics-parser.js';
import { supportsComponent } from '../server/utils/caldav-client.js';
import { _setTestDatabase, _resetTestDatabase } from '../server/db.js';

describe('VTODO field mapping', () => {
  it('maps RFC-5545 PRIORITY to task priority', () => {
    assert.strictEqual(mapVtodoPriority(null), 'none');
    assert.strictEqual(mapVtodoPriority(1), 'high');
    assert.strictEqual(mapVtodoPriority(4), 'high');
    assert.strictEqual(mapVtodoPriority(5), 'medium');
    assert.strictEqual(mapVtodoPriority(6), 'low');
    assert.strictEqual(mapVtodoPriority(9), 'low');
  });

  it('splits a date-only DUE into date with no time', () => {
    assert.deepStrictEqual(splitDue('2026-07-01'), { date: '2026-07-01', time: null });
  });

  it('rechnet einen UTC-Instant in die Wanduhrzeit des Haushalts um', () => {
    // Der Parser liefert UTC, die Aufgabe zeigt eine reine Wanduhrzeit an: ohne
    // Umrechnung stand eine um 16:30 fällige Aufgabe in Yuvomi um 14:30 (#617).
    // TZ=Europe/Berlin ist im npm-Skript gesetzt, im Juli also UTC+2.
    assert.deepStrictEqual(splitDue('2026-07-01T14:30:00Z'), { date: '2026-07-01', time: '16:30' });
    // Über Mitternacht wandert auch das Datum mit.
    assert.deepStrictEqual(splitDue('2026-07-01T23:30:00Z'), { date: '2026-07-02', time: '01:30' });
  });

  it('lässt eine Fälligkeit ohne Zonenangabe unangetastet', () => {
    assert.deepStrictEqual(splitDue('2026-07-01T14:30:00'), { date: '2026-07-01', time: '14:30' });
  });

  it('returns nulls for an empty DUE', () => {
    assert.deepStrictEqual(splitDue(null), { date: null, time: null });
  });
});

describe('pruneRemoved (#508)', () => {
  let db;

  function setup() {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        -- Zeilen dieser Tests gelten als von einem Abruf gesehen (#1839).
        seen_on_server INTEGER NOT NULL DEFAULT 1,
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        title               TEXT NOT NULL,
        external_uid        TEXT,
        external_source     TEXT,
        external_account_id INTEGER
      );
      CREATE TABLE shopping_items (
        -- Zeilen dieser Tests gelten als von einem Abruf gesehen (#1839).
        seen_on_server INTEGER NOT NULL DEFAULT 1,
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        name                TEXT NOT NULL,
        external_uid        TEXT,
        external_source     TEXT,
        external_account_id INTEGER
      );
    `);
  }

  function addTask(title, uid, source, accountId) {
    db.prepare(`
      INSERT INTO tasks (title, external_uid, external_source, external_account_id)
      VALUES (?, ?, ?, ?)
    `).run(title, uid, source, accountId);
  }

  function taskTitles() {
    return db.prepare('SELECT title FROM tasks ORDER BY id').all().map(r => r.title);
  }

  it('deletes mirrored tasks the server no longer returns', () => {
    setup();
    addTask('Bleibt', 'uid-1', 'caldav', 1);
    addTask('In iCloud geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneRemoved(db, 'tasks', 1, ['uid-1']);

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(taskTitles(), ['Bleibt']);
  });

  it('does NOT wipe every task when the server returns nothing (fetch-error guard)', () => {
    setup();
    addTask('A', 'uid-1', 'caldav', 1);
    addTask('B', 'uid-2', 'caldav', 1);

    const removed = pruneRemoved(db, 'tasks', 1, []);

    assert.strictEqual(removed, 0, 'An empty reminder fetch must not wipe the account');
    assert.deepStrictEqual(taskTitles(), ['A', 'B']);
  });

  it('never touches locally created tasks', () => {
    setup();
    addTask('Lokale Aufgabe', null, null, null);
    addTask('Remote geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneRemoved(db, 'tasks', 1, ['uid-1']);

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(taskTitles(), ['Lokale Aufgabe']);
  });

  it('never touches tasks of another account', () => {
    setup();
    addTask('Anderer Account', 'uid-other', 'caldav', 2);
    addTask('Remote geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneRemoved(db, 'tasks', 1, ['uid-1']);

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(taskTitles(), ['Anderer Account']);
  });

  it('prunes shopping_items the same way', () => {
    setup();
    db.prepare(`
      INSERT INTO shopping_items (name, external_uid, external_source, external_account_id)
      VALUES ('Bleibt', 'uid-1', 'caldav', 1), ('Weg', 'uid-2', 'caldav', 1)
    `).run();

    const removed = pruneRemoved(db, 'shopping_items', 1, ['uid-1']);

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(
      db.prepare('SELECT name FROM shopping_items ORDER BY id').all().map(r => r.name),
      ['Bleibt']
    );
  });

  it('refuses to prune a table outside the whitelist', () => {
    setup();
    assert.throws(
      () => pruneRemoved(db, 'users; DROP TABLE tasks', 1, ['uid-1']),
      /refusing to prune unknown table/
    );
  });
});

describe('caldav_reminder_selection schema & upsert logic', () => {
  let db;

  before(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE caldav_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        caldav_url TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        UNIQUE(caldav_url, username)
      );
      CREATE TABLE caldav_reminder_selection (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id    INTEGER NOT NULL,
        list_url      TEXT NOT NULL,
        list_name     TEXT NOT NULL,
        target_module TEXT NOT NULL DEFAULT 'tasks'
                      CHECK(target_module IN ('tasks', 'shopping')),
        target_list_id INTEGER,
        enabled       INTEGER NOT NULL DEFAULT 0,
        writable      INTEGER,
        FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE,
        UNIQUE(account_id, list_url)
      );
      CREATE TABLE caldav_reminder_assignees (selection_id INTEGER NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (selection_id, user_id));
      CREATE TABLE shopping_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
      );
      CREATE TABLE shopping_items (
        -- Zeilen dieser Tests gelten als von einem Abruf gesehen (#1839).
        seen_on_server INTEGER NOT NULL DEFAULT 1,
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        quantity TEXT,
        category TEXT NOT NULL DEFAULT 'Sonstiges',
        is_checked INTEGER NOT NULL DEFAULT 0,
        external_uid TEXT,
        external_source TEXT NOT NULL DEFAULT 'local',
        external_account_id INTEGER
      );
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
      INSERT INTO users (username) VALUES ('owner');
      CREATE TABLE tasks (
        -- Zeilen dieser Tests gelten als von einem Abruf gesehen (#1839).
        seen_on_server INTEGER NOT NULL DEFAULT 1,
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT NOT NULL DEFAULT 'none',
        status TEXT NOT NULL DEFAULT 'open',
        due_date TEXT,
        due_time TEXT,
        created_by INTEGER NOT NULL,
        external_uid TEXT,
        external_source TEXT NOT NULL DEFAULT 'local',
        external_account_id INTEGER
      );
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES ('iCloud', 'https://caldav.icloud.com', 'u', 'p');
    `);
  });

  it('reminder selection defaults to disabled and tasks module', () => {
    const accId = db.prepare('SELECT id FROM caldav_accounts').get().id;
    db.prepare(`
      INSERT INTO caldav_reminder_selection (account_id, list_url, list_name)
      VALUES (?, ?, ?)
    `).run(accId, 'https://caldav.icloud.com/reminders/list1', 'Einkauf');
    const sel = db.prepare('SELECT * FROM caldav_reminder_selection WHERE list_name = ?').get('Einkauf');
    assert.strictEqual(sel.enabled, 0, 'should default disabled');
    assert.strictEqual(sel.target_module, 'tasks', 'should default to tasks');
  });

  it('rejects an invalid target_module via CHECK constraint', () => {
    const accId = db.prepare('SELECT id FROM caldav_accounts').get().id;
    assert.throws(() => {
      db.prepare(`
        INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module)
        VALUES (?, ?, ?, 'calendar')
      `).run(accId, 'https://x/bad', 'Bad');
    });
  });

  it('CASCADE deletes reminder selections when the account is removed', () => {
    const tmp = new DatabaseSync(':memory:');
    tmp.exec(`
      CREATE TABLE caldav_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
      CREATE TABLE caldav_reminder_selection (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        list_url TEXT NOT NULL, list_name TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE caldav_reminder_assignees (selection_id INTEGER NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (selection_id, user_id));
    `);
    tmp.exec('PRAGMA foreign_keys = ON');
    tmp.prepare('INSERT INTO caldav_accounts (name) VALUES (?)').run('A');
    const id = tmp.prepare('SELECT id FROM caldav_accounts').get().id;
    tmp.prepare('INSERT INTO caldav_reminder_selection (account_id, list_url, list_name) VALUES (?,?,?)')
      .run(id, 'u', 'n');
    tmp.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(id);
    const left = tmp.prepare('SELECT * FROM caldav_reminder_selection WHERE account_id = ?').get(id);
    assert.strictEqual(left, undefined, 'reminder selection should cascade-delete');
  });

  it('upserts a VTODO into tasks keyed on external_uid (insert then update, no duplicate)', () => {
    const accId = db.prepare('SELECT id FROM caldav_accounts').get().id;
    const owner = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
    const upsertTask = (uid, title, status) => {
      const existing = db.prepare(
        `SELECT id FROM tasks WHERE external_uid = ? AND external_source = 'caldav'`
      ).get(uid);
      if (existing) {
        db.prepare(`UPDATE tasks SET title = ?, status = ? WHERE id = ?`).run(title, status, existing.id);
      } else {
        db.prepare(`
          INSERT INTO tasks (title, status, created_by, external_uid, external_source, external_account_id)
          VALUES (?, ?, ?, ?, 'caldav', ?)
        `).run(title, status, owner, uid, accId);
      }
    };
    upsertTask('todo-1@x', 'Milch kaufen', 'open');
    upsertTask('todo-1@x', 'Milch & Brot kaufen', 'done');
    const rows = db.prepare(`SELECT * FROM tasks WHERE external_uid = 'todo-1@x'`).all();
    assert.strictEqual(rows.length, 1, 'should not create a duplicate task');
    assert.strictEqual(rows[0].title, 'Milch & Brot kaufen', 'should update title');
    assert.strictEqual(rows[0].status, 'done', 'should update status');
  });

  it('deletes local caldav tasks that disappeared from the remote list', () => {
    const accId = db.prepare('SELECT id FROM caldav_accounts').get().id;
    const owner = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO tasks (title, status, created_by, external_uid, external_source, external_account_id)
      VALUES ('Stale', 'open', ?, 'stale@x', 'caldav', ?)`).run(owner, accId);
    // Remote returns only 'fresh@x'
    const seenUids = ['fresh@x'];
    const placeholders = seenUids.map(() => '?').join(',');
    db.prepare(`DELETE FROM tasks
      WHERE external_source = 'caldav' AND external_account_id = ?
        AND external_uid NOT IN (${placeholders})`).run(accId, ...seenUids);
    const stale = db.prepare(`SELECT * FROM tasks WHERE external_uid = 'stale@x'`).get();
    assert.strictEqual(stale, undefined, 'stale caldav task should be removed');
  });
});

// --------------------------------------------------------
// Komponentenzuordnung (#617)
// --------------------------------------------------------

describe('supportsComponent: Termine und Aufgaben teilen eine Regel (#617)', () => {
  it('hält Aufgabenlisten aus der Kalenderauswahl und Kalender aus der Aufgabenauswahl', () => {
    const todoList = { components: ['VTODO'] };
    const calendar = { components: ['VEVENT'] };

    assert.strictEqual(supportsComponent(todoList, 'VTODO'), true);
    assert.strictEqual(supportsComponent(todoList, 'VEVENT'), false,
      'eine reine Aufgabenliste darf nicht als Kalender angeboten werden');
    assert.strictEqual(supportsComponent(calendar, 'VEVENT'), true);
    assert.strictEqual(supportsComponent(calendar, 'VTODO'), false);
  });

  it('lässt eine gemischte Collection auf beiden Seiten zu', () => {
    const mixed = { components: ['VTODO', 'VEVENT', 'VJOURNAL'] };
    assert.strictEqual(supportsComponent(mixed, 'VEVENT'), true);
    assert.strictEqual(supportsComponent(mixed, 'VTODO'), true);
  });

  it('nimmt ohne Angabe des Servers alle Komponenten an (RFC 4791 §5.2.3)', () => {
    // Die Property ist optional. Wer strikt filtert, blendet auf solchen Servern
    // jede Collection aus - vorher galt das für die Aufgabenseite.
    for (const cal of [{}, { components: [] }, { components: null }]) {
      assert.strictEqual(supportsComponent(cal, 'VTODO'), true, JSON.stringify(cal));
      assert.strictEqual(supportsComponent(cal, 'VEVENT'), true, JSON.stringify(cal));
    }
  });

  it('vergleicht Komponentennamen unabhängig von der Schreibweise', () => {
    assert.strictEqual(supportsComponent({ components: ['vtodo'] }, 'VTODO'), true);
  });
});

describe('Kalenderauswahl übernimmt nur VEVENT-Collections (#617)', () => {
  // Regel statt Allowlist: jede Schleife, die in caldav_calendar_selection
  // schreibt, muss über eventCalendars() laufen. Es sind drei (Konto anlegen,
  // Zugangsdaten ändern, Kalender aktualisieren) - eine übersehene Stelle bietet
  // Aufgabenlisten wieder als Terminziel an.
  const source = readFileSync(new URL('../server/services/caldav-sync.js', import.meta.url), 'utf8');

  it('führt jeden INSERT über eventCalendars()', () => {
    const lines = source.split('\n');
    const inserts = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /INSERT INTO caldav_calendar_selection/.test(line));

    assert.ok(inserts.length >= 3, `erwartet mindestens 3 Schreibstellen, gefunden ${inserts.length}`);

    for (const { i } of inserts) {
      // Die umschließende for-Schleife steht oberhalb des INSERT.
      const preceding = lines.slice(Math.max(0, i - 12), i).reverse();
      const loop = preceding.find(l => /for \(const \w+ of /.test(l));
      assert.ok(loop, `keine Schleife über dem INSERT in Zeile ${i + 1}`);
      assert.match(loop, /eventCalendars\(/,
        `Zeile ${i + 1}: Kalenderauswahl wird ungefiltert befüllt - `
        + 'eine reine Aufgabenliste landet damit als Speicherziel für Termine');
    }
  });
});

describe('Aufgabenlisten erscheinen ohne Knopfdruck (#617)', () => {
  let db;

  function stubClient(components) {
    return async () => ({
      fetchCalendars: async () => [
        { url: 'https://dav.example/termine/',  displayName: 'Termine',  components: ['VEVENT'] },
        { url: 'https://dav.example/aufgaben/', displayName: 'Aufgaben', components },
      ],
    });
  }

  before(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE caldav_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, caldav_url TEXT NOT NULL,
        username TEXT NOT NULL, password TEXT NOT NULL,
        reminders_discovered_at TEXT
      );
      CREATE TABLE caldav_reminder_selection (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id    INTEGER NOT NULL,
        list_url      TEXT NOT NULL,
        list_name     TEXT NOT NULL,
        target_module TEXT NOT NULL DEFAULT 'tasks',
        target_list_id INTEGER,
        enabled       INTEGER NOT NULL DEFAULT 0,
        writable      INTEGER,
        UNIQUE(account_id, list_url)
      );
      CREATE TABLE caldav_reminder_assignees (selection_id INTEGER NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (selection_id, user_id));
      -- Die gelesene Auswahl nennt die Standard-Personen je Liste (#1221).
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT);
      -- Die gelesene Auswahl zaehlt die wartenden Uploads je Liste (#1840).
      CREATE TABLE tasks (
        -- Zeilen dieser Tests gelten als von einem Abruf gesehen (#1839).
        seen_on_server INTEGER NOT NULL DEFAULT 1,
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_source TEXT DEFAULT 'local',
        target_caldav_account_id INTEGER, target_caldav_list_url TEXT, parent_task_id INTEGER
      );
      CREATE TABLE shopping_items (
        -- Zeilen dieser Tests gelten als von einem Abruf gesehen (#1839).
        seen_on_server INTEGER NOT NULL DEFAULT 1,
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_source TEXT DEFAULT 'local', list_id INTEGER
      );
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES ('Radicale', 'https://dav.example/', 'demo', 'pw');
    `);
    _setTestDatabase(db);
  });

  it('sucht beim ersten Aufruf selbst, statt einen leeren Zustand zu zeigen', async () => {
    // Das Anlegen eines Kontos entdeckt nur Kalender. Ohne diesen Griff zum
    // Server blieb die Seite leer, bis jemand "Aktualisieren" fand - und der
    // Abgleich sah kaputt aus, obwohl er nur nichts zu tun hatte.
    const lists = await getReminderLists(1, { createClient: stubClient(['VTODO']) });

    assert.strictEqual(lists.length, 1);
    assert.strictEqual(lists[0].listName, 'Aufgaben');
    assert.strictEqual(lists[0].enabled, false, 'gefunden heißt nicht eingeschaltet');
  });

  it('liest danach aus der Datenbank, ohne den Server erneut zu fragen', async () => {
    const explode = async () => { throw new Error('darf den Server nicht erneut fragen'); };
    const lists = await getReminderLists(1, { createClient: explode });
    assert.strictEqual(lists.length, 1);
  });

  it('behält eine eingeschaltete Liste über eine erneute Suche hinweg', async () => {
    db.prepare('UPDATE caldav_reminder_selection SET enabled = 1').run();
    const lists = await getReminderLists(1, { refresh: true, createClient: stubClient(['VTODO']) });
    assert.strictEqual(lists[0].enabled, true, 'die Auswahl des Nutzers darf eine Suche nicht zurücksetzen');
  });

  it('nimmt jede Liste mit, wenn der Server keine Komponenten meldet', async () => {
    // Server ohne `supported-calendar-component-set`: RFC 4791 §5.2.3 verlangt,
    // dass dann alle Komponenten gelten. Vorher fiel dort jede Liste durch das
    // Raster und die Seite blieb leer, obwohl Aufgaben da waren.
    const silentServer = async () => ({
      fetchCalendars: async () => [
        { url: 'https://dav.example/eins/', displayName: 'Eins' },
        { url: 'https://dav.example/zwei/', displayName: 'Zwei', components: [] },
      ],
    });

    db.prepare('DELETE FROM caldav_reminder_selection').run();
    const lists = await getReminderLists(1, { refresh: true, createClient: silentServer });
    assert.deepStrictEqual(lists.map(l => l.listName), ['Eins', 'Zwei']);
  });

  it('fragt einen Server ohne Aufgabenlisten nur einmal', async () => {
    // Ein leeres Ergebnis ist auch ein Ergebnis. Solange nur die leere
    // Auswahltabelle als "noch nie gesucht" galt, hätte jeder Aufruf der
    // Einstellungsseite erneut den Server befragt.
    db.prepare('DELETE FROM caldav_reminder_selection').run();
    db.prepare('UPDATE caldav_accounts SET reminders_discovered_at = NULL').run();

    let calls = 0;
    const emptyServer = async () => { calls++; return { fetchCalendars: async () => [] }; };

    assert.deepStrictEqual(await getReminderLists(1, { createClient: emptyServer }), []);
    assert.deepStrictEqual(await getReminderLists(1, { createClient: emptyServer }), []);
    assert.deepStrictEqual(await getReminderLists(1, { createClient: emptyServer }), []);
    assert.strictEqual(calls, 1, 'ein leeres Ergebnis muss gemerkt werden');

    // Der Knopf sucht weiterhin auf Zuruf.
    await getReminderLists(1, { refresh: true, createClient: emptyServer });
    assert.strictEqual(calls, 2);
  });

  it('gibt die Test-Datenbank wieder frei', () => {
    _resetTestDatabase();
  });
});

// #671: Unteraufgaben aus Apple Reminders/Nextcloud landeten in Yuvomi als
// eigenständige Aufgaben nebeneinander, weil der Parser RELATED-TO gar nicht
// las. Der Melder sah zehn flache Einträge statt zweier Listen mit Kindern.
describe('VTODO-Hierarchie über RELATED-TO (#671)', () => {
  const vtodo = (uid, summary, extra = '') =>
    `BEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${summary}\r\n${extra}END:VTODO\r\n`;
  const wrap = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;

  it('liest RELATED-TO ohne RELTYPE als Elternangabe (RFC-5545-Default)', () => {
    const [todo] = parseVTODO(wrap(vtodo('kind-1', 'AOS4 Nether', 'RELATED-TO:aos-4\r\n')));
    assert.strictEqual(todo.parentUid, 'aos-4');
    assert.deepStrictEqual(todo.childUids, []);
  });

  it('liest RELTYPE=PARENT und ignoriert SIBLING', () => {
    const [todo] = parseVTODO(wrap(vtodo('kind-2', 'AOS4 End',
      'RELATED-TO;RELTYPE=SIBLING:egal\r\nRELATED-TO;RELTYPE=PARENT:aos-4\r\n')));
    assert.strictEqual(todo.parentUid, 'aos-4');
  });

  it('liest die Gegenrichtung RELTYPE=CHILD am Elternteil', () => {
    const [todo] = parseVTODO(wrap(vtodo('aos-4', 'AOS 4',
      'RELATED-TO;RELTYPE=CHILD:kind-1\r\nRELATED-TO;RELTYPE=CHILD:kind-2\r\n')));
    assert.strictEqual(todo.parentUid, null);
    assert.deepStrictEqual(todo.childUids, ['kind-1', 'kind-2']);
  });

  it('kommt ohne RELATED-TO auf null statt undefined', () => {
    const [todo] = parseVTODO(wrap(vtodo('allein', 'Add OAuth')));
    assert.strictEqual(todo.parentUid, null);
    assert.deepStrictEqual(todo.childUids, []);
  });
});

describe('applyTaskRelations (#671)', () => {
  let db;

  const seed = (rows) => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE tasks (
  -- Zeilen dieser Tests gelten als von einem Abruf gesehen (#1839).
  seen_on_server INTEGER NOT NULL DEFAULT 1,
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE
    );`);
    _setTestDatabase(db);
    const insert = db.prepare('INSERT INTO tasks (title, parent_task_id) VALUES (?, ?)');
    const map = new Map();
    for (const [uid, title, parentUid, childUids, existingParentUid] of rows) {
      const id = insert.run(title, null).lastInsertRowid;
      map.set(uid, { taskId: id, parentUid: parentUid || null, childUids: childUids || [], existingParentUid });
    }
    // Bestehende Zuordnung nachtragen, sobald alle IDs bekannt sind.
    for (const [, entry] of map) {
      if (entry.existingParentUid) {
        db.prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?')
          .run(map.get(entry.existingParentUid).taskId, entry.taskId);
      }
    }
    return map;
  };
  const parentOf = (map, uid) =>
    db.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(map.get(uid).taskId).parent_task_id;

  it('hängt die Kinder unter ihren Elternteil', () => {
    const map = seed([
      ['aos-4', 'AOS 4', null, []],
      ['nether', 'AOS4 Nether', 'aos-4', []],
      ['end', 'AOS4 End', 'aos-4', []],
    ]);
    applyTaskRelations(map);
    assert.strictEqual(parentOf(map, 'aos-4'), null);
    assert.strictEqual(parentOf(map, 'nether'), map.get('aos-4').taskId);
    assert.strictEqual(parentOf(map, 'end'), map.get('aos-4').taskId);
    _resetTestDatabase();
  });

  it('verdrahtet auch, wenn das Kind vor dem Elternteil kommt', () => {
    // Der Objektstrom des Servers hat keine garantierte Reihenfolge, und über
    // zwei Listen hinweg schon gar nicht - deshalb läuft die Auflösung als
    // eigene Phase nach dem Upsert.
    const map = seed([
      ['nether', 'AOS4 Nether', 'aos-4', []],
      ['aos-4', 'AOS 4', null, []],
    ]);
    applyTaskRelations(map);
    assert.strictEqual(parentOf(map, 'nether'), map.get('aos-4').taskId);
    _resetTestDatabase();
  });

  it('akzeptiert die Gegenrichtung über childUids', () => {
    const map = seed([
      ['aos-4', 'AOS 4', null, ['nether']],
      ['nether', 'AOS4 Nether', null, []],
    ]);
    applyTaskRelations(map);
    assert.strictEqual(parentOf(map, 'nether'), map.get('aos-4').taskId);
    _resetTestDatabase();
  });

  it('hebt ein Enkelkind auf den obersten Vorfahren, statt es fallen zu lassen', () => {
    // Yuvomi kennt eine Ebene, CalDAV beliebig viele. Flach unter dem Kopf ist
    // immer noch eine Hierarchie; gar keine wäre der gemeldete Zustand.
    const map = seed([
      ['a', 'Oben', null, []],
      ['b', 'Mitte', 'a', []],
      ['c', 'Unten', 'b', []],
    ]);
    applyTaskRelations(map);
    assert.strictEqual(parentOf(map, 'b'), map.get('a').taskId);
    assert.strictEqual(parentOf(map, 'c'), map.get('a').taskId);
    _resetTestDatabase();
  });

  it('lässt einen unbekannten Elternteil flach, statt zu raten', () => {
    const map = seed([['waise', 'Kind ohne Eltern', 'nicht-abgerufen', []]]);
    applyTaskRelations(map);
    assert.strictEqual(parentOf(map, 'waise'), null);
    _resetTestDatabase();
  });

  it('bricht bei einem Zyklus ab, statt sich aufzuhängen', () => {
    const map = seed([
      ['a', 'A', 'b', []],
      ['b', 'B', 'a', []],
    ]);
    applyTaskRelations(map);
    assert.strictEqual(parentOf(map, 'a'), null);
    assert.strictEqual(parentOf(map, 'b'), null);
    _resetTestDatabase();
  });

  it('löst eine entfernte Beziehung wieder auf', () => {
    // Wer auf dem Server aus der Unterliste gezogen wird, muss auch in Yuvomi
    // wieder oben stehen - sonst bleibt er für immer ein Kind.
    const map = seed([
      ['aos-4', 'AOS 4', null, []],
      ['nether', 'AOS4 Nether', null, [], 'aos-4'],
    ]);
    assert.strictEqual(parentOf(map, 'nether'), map.get('aos-4').taskId, 'Vorbedingung');
    applyTaskRelations(map);
    assert.strictEqual(parentOf(map, 'nether'), null);
    _resetTestDatabase();
  });

  it('ignoriert den Selbstbezug', () => {
    const map = seed([['a', 'A', 'a', []]]);
    applyTaskRelations(map);
    assert.strictEqual(parentOf(map, 'a'), null);
    _resetTestDatabase();
  });
});
