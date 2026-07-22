/**
 * Test: CalDAV Multi-Account Sync
 * Purpose: Verify CalDAV multi-account functionality
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { toICSDatetime, sync } from '../server/services/caldav-sync.js';
import { pruneDeletedEvents } from '../server/services/calendar-prune.js';
import { _setTestDatabase, _resetTestDatabase } from '../server/db.js';

const TEST_DB = ':memory:';

describe('CalDAV Multi-Account Sync', () => {
  let db;

  before(() => {
    // Create in-memory DB
    db = new DatabaseSync(TEST_DB);

    // Create tables (simplified schema for testing)
    db.exec(`
      CREATE TABLE caldav_accounts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        caldav_url      TEXT NOT NULL,
        username        TEXT NOT NULL,
        password        TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_sync       TEXT,
        UNIQUE(caldav_url, username)
      );

      CREATE TABLE caldav_calendar_selection (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      INTEGER NOT NULL,
        calendar_url    TEXT NOT NULL,
        calendar_name   TEXT NOT NULL,
        calendar_color  TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE,
        UNIQUE(account_id, calendar_url)
      );

      CREATE TABLE calendar_events (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        title                       TEXT NOT NULL,
        external_calendar_id        TEXT,
        external_source             TEXT,
        target_caldav_account_id    INTEGER,
        target_caldav_calendar_url  TEXT
      );

      CREATE TABLE external_calendars (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source      TEXT NOT NULL,
        external_id TEXT NOT NULL,
        name        TEXT NOT NULL,
        color       TEXT,
        UNIQUE(source, external_id)
      );

      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL
      );

      INSERT INTO users (username) VALUES ('testuser');
    `);
  });

  it('should create caldav_accounts table with correct schema', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='caldav_accounts'").get();
    assert.ok(result, 'caldav_accounts table should exist');
  });

  it('should create caldav_calendar_selection table with FK', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='caldav_calendar_selection'").get();
    assert.ok(result, 'caldav_calendar_selection table should exist');
  });

  it('should have target columns in calendar_events', () => {
    const cols = db.prepare("PRAGMA table_info(calendar_events)").all();
    const colNames = cols.map(c => c.name);

    assert.ok(colNames.includes('target_caldav_account_id'), 'Should have target_caldav_account_id column');
    assert.ok(colNames.includes('target_caldav_calendar_url'), 'Should have target_caldav_calendar_url column');
  });

  it('should insert account and enforce UNIQUE constraint', () => {
    db.prepare(`
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run('Test Account', 'https://caldav.example.com', 'user', 'pass');

    const account = db.prepare('SELECT * FROM caldav_accounts WHERE name = ?').get('Test Account');
    assert.ok(account, 'Account should be inserted');
    assert.strictEqual(account.caldav_url, 'https://caldav.example.com');

    // Duplicate should fail
    assert.throws(() => {
      db.prepare(`
        INSERT INTO caldav_accounts (name, caldav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('Duplicate', 'https://caldav.example.com', 'user', 'pass');
    }, 'UNIQUE constraint should prevent duplicates');
  });

  it('should insert calendar selection and link to account', () => {
    const accountId = db.prepare('SELECT id FROM caldav_accounts WHERE name = ?').get('Test Account').id;

    db.prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, enabled)
      VALUES (?, ?, ?, ?)
    `).run(accountId, 'https://cal.example.com/cal1', 'Private', 1);

    const calendar = db.prepare('SELECT * FROM caldav_calendar_selection WHERE account_id = ?').get(accountId);
    assert.ok(calendar, 'Calendar should be inserted');
    assert.strictEqual(calendar.calendar_name, 'Private');
    assert.strictEqual(calendar.enabled, 1);
  });

  it('should CASCADE delete calendar_selection when account deleted', () => {
    const accountId = db.prepare('SELECT id FROM caldav_accounts WHERE name = ?').get('Test Account').id;

    // Delete account
    db.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(accountId);

    // Calendar selection should be deleted
    const remaining = db.prepare('SELECT * FROM caldav_calendar_selection WHERE account_id = ?').get(accountId);
    assert.strictEqual(remaining, undefined, 'Calendar selection should be deleted via CASCADE');
  });

  it('should handle enabled/disabled calendar selection', () => {
    // Insert new account
    db.prepare(`
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run('Account 2', 'https://caldav2.example.com', 'user2', 'pass2');

    const accountId = db.prepare('SELECT id FROM caldav_accounts WHERE name = ?').get('Account 2').id;

    // Insert calendars
    db.prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, enabled)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      accountId, 'https://cal.example.com/cal1', 'Private', 1,
      accountId, 'https://cal.example.com/cal2', 'Work', 0
    );

    // Query only enabled
    const enabled = db.prepare('SELECT * FROM caldav_calendar_selection WHERE account_id = ? AND enabled = 1').all(accountId);
    assert.strictEqual(enabled.length, 1, 'Should have 1 enabled calendar');
    assert.strictEqual(enabled[0].calendar_name, 'Private');
  });

  it('should migrate apple calendar events to caldav without violating CHECK', () => {
    const db2 = new DatabaseSync(':memory:');
    db2.exec(`
      CREATE TABLE calendar_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT NOT NULL,
        external_source TEXT NOT NULL DEFAULT 'local'
                        CHECK(external_source IN ('local', 'google', 'apple', 'ics'))
      );
    `);

    db2.prepare(`
      INSERT INTO calendar_events (title, external_source)
      VALUES ('Migrated', 'apple')
    `).run();

    db2.exec(`
      CREATE TABLE calendar_events_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT NOT NULL,
        external_source TEXT NOT NULL DEFAULT 'local'
                        CHECK(external_source IN ('local', 'google', 'apple', 'ics', 'caldav'))
      );
    `);

    db2.exec(`
      INSERT INTO calendar_events_new (id, title, external_source)
      SELECT id, title,
             CASE WHEN external_source = 'apple' THEN 'caldav' ELSE external_source END
      FROM calendar_events
    `);

    const migrated = db2.prepare(`SELECT external_source FROM calendar_events_new WHERE title = 'Migrated'`).get();
    assert.strictEqual(migrated.external_source, 'caldav');
  });
});

describe('Auto-Sync-Scheduler-Verdrahtung (#508)', () => {
  // #508: caldav-sync.js war nie im Scheduler verdrahtet — CalDAV-Kalender synchten
  // ausschliesslich per Hand-Klick, obwohl das Log "Auto-sync active" meldete.
  // Der Guard pinnt, dass jeder Sync-Service in runSync() tatsaechlich aufgerufen wird.
  const SYNC_CALLS = [
    'googleCalendar.sync()',
    'appleCalendar.sync()',
    'icsSubscription.sync()',
    'caldavSync.sync()',
    'caldavReminders.sync()',
    'carddavSync.sync()',
    'holidays.sync()',
  ];

  const source  = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const runSync = source.slice(
    source.indexOf('async function runSync()'),
    source.indexOf('// Server starten')
  );

  it('extracts the runSync body (guard stays meaningful if index.js is restructured)', () => {
    assert.ok(runSync.length > 0, 'runSync() body not found in server/index.js');
  });

  for (const call of SYNC_CALLS) {
    it(`calls ${call} in runSync()`, () => {
      assert.ok(runSync.includes(call), `${call} is missing from runSync() — service will never auto-sync`);
    });
  }
});

describe('pruneDeletedEvents (#508)', () => {
  let db;

  function setup() {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE calendar_events (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        title                TEXT NOT NULL,
        external_calendar_id TEXT,
        external_source      TEXT NOT NULL DEFAULT 'local',
        calendar_ref_id      INTEGER
      );
    `);
  }

  function addEvent(title, uid, source, calRefId) {
    db.prepare(`
      INSERT INTO calendar_events (title, external_calendar_id, external_source, calendar_ref_id)
      VALUES (?, ?, ?, ?)
    `).run(title, uid, source, calRefId);
  }

  function titles() {
    return db.prepare('SELECT title FROM calendar_events ORDER BY id').all().map(r => r.title);
  }

  it('deletes events the server no longer returns', () => {
    setup();
    addEvent('Bleibt', 'uid-1', 'caldav', 1);
    addEvent('In iCloud geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneDeletedEvents(db, { calRefId: 1, calendarUids: new Set(['uid-1']) });

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(titles(), ['Bleibt']);
  });

  it('returns 0 and deletes nothing when the server still has every event', () => {
    setup();
    addEvent('A', 'uid-1', 'caldav', 1);
    addEvent('B', 'uid-2', 'caldav', 1);

    const removed = pruneDeletedEvents(db, { calRefId: 1, calendarUids: new Set(['uid-1', 'uid-2']) });

    assert.strictEqual(removed, 0);
    assert.deepStrictEqual(titles(), ['A', 'B']);
  });

  it('never touches local events, even with a matching calendar_ref_id', () => {
    setup();
    addEvent('Lokaler Termin', null, 'local', 1);
    addEvent('Outbound, noch nicht hochgeladen', null, 'local', 1);
    addEvent('Remote geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneDeletedEvents(db, { calRefId: 1, calendarUids: new Set(['uid-1']) });

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(titles(), ['Lokaler Termin', 'Outbound, noch nicht hochgeladen']);
  });

  it('never touches events of another calendar', () => {
    setup();
    addEvent('Anderer Kalender', 'uid-other', 'caldav', 2);
    addEvent('Remote geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneDeletedEvents(db, { calRefId: 1, calendarUids: new Set(['uid-1']) });

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(titles(), ['Anderer Kalender']);
  });

  it('skips deletion when the calendar returned no events at all (fetch-error guard)', () => {
    setup();
    addEvent('A', 'uid-1', 'caldav', 1);
    addEvent('B', 'uid-2', 'caldav', 1);

    const removed = pruneDeletedEvents(db, { calRefId: 1, calendarUids: new Set() });

    assert.strictEqual(removed, 0, 'An empty fetch must not wipe the calendar');
    assert.deepStrictEqual(titles(), ['A', 'B']);
  });

  it('keeps an event that moved to another calendar within the same account', () => {
    setup();
    // Termin wurde nach Kalender 2 verschoben: calendar_ref_id zeigt noch auf 1,
    // die UID liefert aber Kalender 2 des Accounts.
    addEvent('Verschoben', 'uid-moved', 'caldav', 1);

    const removed = pruneDeletedEvents(db, {
      calRefId: 1,
      calendarUids: new Set(['uid-1']),
      accountUids: new Set(['uid-1', 'uid-moved']),
    });

    assert.strictEqual(removed, 0);
    assert.deepStrictEqual(titles(), ['Verschoben']);
  });

  it('only prunes the given source: apple events survive a caldav prune', () => {
    setup();
    addEvent('Apple-Termin', 'uid-apple', 'apple', 1);
    addEvent('CalDAV, remote geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneDeletedEvents(db, {
      calRefId: 1, calendarUids: new Set(['uid-1']), source: 'caldav',
    });

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(titles(), ['Apple-Termin']);
  });

  it('prunes apple events when source is apple (#508 legacy sync)', () => {
    setup();
    addEvent('Bleibt', 'uid-1', 'apple', 1);
    addEvent('In iCloud geloescht', 'uid-2', 'apple', 1);
    addEvent('CalDAV bleibt', 'uid-caldav', 'caldav', 1);

    const removed = pruneDeletedEvents(db, {
      calRefId: 1, calendarUids: new Set(['uid-1']), source: 'apple',
    });

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(titles(), ['Bleibt', 'CalDAV bleibt']);
  });
});

describe('toICSDatetime (#246)', () => {
  it('pads missing seconds to HHMMSS (main bug: HH:MM → 4-digit time)', () => {
    assert.strictEqual(toICSDatetime('2024-06-14T14:30'), '20240614T143000');
  });

  it('handles HH:MM:SS correctly', () => {
    assert.strictEqual(toICSDatetime('2024-06-14T14:30:00'), '20240614T143000');
  });

  it('strips milliseconds', () => {
    assert.strictEqual(toICSDatetime('2024-06-14T14:30:00.000'), '20240614T143000');
  });

  it('preserves Z suffix', () => {
    assert.strictEqual(toICSDatetime('2024-06-14T14:30:00Z'), '20240614T143000Z');
  });

  it('preserves timezone offset and removes colon', () => {
    assert.strictEqual(toICSDatetime('2024-06-14T14:30:00+02:00'), '20240614T143000+0200');
  });

  it('returns midnight for date-only strings', () => {
    assert.strictEqual(toICSDatetime('2024-06-14'), '20240614T000000');
  });

  it('returns empty string for null/undefined', () => {
    assert.strictEqual(toICSDatetime(null), '');
    assert.strictEqual(toICSDatetime(''), '');
  });
});

// --------------------------------------------------------
// #519: Inbound-Sync darf den Event-Loop nicht für die gesamte Dauer blockieren.
// node:sqlite ist synchron; ohne periodischen Yield friert die App beim Navigieren
// ein, solange ein großer Kalender verarbeitet wird. Der Sync wird per injizierter
// Client-Factory getrieben (kein echter tsdav-/Netzwerkzugriff).
// --------------------------------------------------------
describe('CalDAV sync yields to the event loop (#519)', () => {
  const CALENDAR_URL = 'https://dav.example/cal-1/';

  function buildDb() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT);
      INSERT INTO users (display_name) VALUES ('Owner');

      CREATE TABLE caldav_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, caldav_url TEXT, username TEXT, password TEXT, last_sync TEXT
      );
      CREATE TABLE caldav_calendar_selection (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER, calendar_url TEXT, calendar_name TEXT,
        calendar_color TEXT, enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE external_calendars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT, color TEXT,
        default_assignee_user_id INTEGER,
        UNIQUE(source, external_id)
      );
      CREATE TABLE calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, description TEXT,
        start_datetime TEXT, end_datetime TEXT, all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT, color TEXT, recurrence_rule TEXT,
        external_calendar_id TEXT, external_source TEXT,
        calendar_ref_id INTEGER, created_by INTEGER,
        user_modified INTEGER NOT NULL DEFAULT 0, assigned_to INTEGER,
        target_caldav_account_id INTEGER, target_caldav_calendar_url TEXT
      );
      CREATE TABLE event_assignments (
        event_id INTEGER, user_id INTEGER, UNIQUE(event_id, user_id)
      );
      CREATE TABLE calendar_event_exceptions (
        event_id INTEGER NOT NULL, exception_date TEXT NOT NULL,
        PRIMARY KEY (event_id, exception_date)
      );

      INSERT INTO caldav_accounts (name, caldav_url, username, password)
        VALUES ('Radicale', 'https://dav.example/', 'u', 'p');
      INSERT INTO caldav_calendar_selection
        (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (1, '${CALENDAR_URL}', 'Cal 1', '#4A90E2', 1);
    `);
    return d;
  }

  // Liefert eine Client-Factory, deren Kalender `objectCount` VEVENT-Objekte enthält.
  function fakeClientFactory(objectCount) {
    const objects = Array.from({ length: objectCount }, (_, i) => ({
      data: [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
        `UID:evt-${i}@test`, `SUMMARY:Event ${i}`,
        'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z',
        'END:VEVENT', 'END:VCALENDAR',
      ].join('\r\n'),
    }));
    return async () => ({
      fetchCalendars:       async () => [{ url: CALENDAR_URL, displayName: 'Cal 1' }],
      fetchCalendarObjects: async () => objects,
      createCalendarObject: async () => ({}),
    });
  }

  // Zählt Makrotask-Durchläufe des Event-Loops. Ohne Yield liefe die komplette
  // Inbound-Verarbeitung in EINEM Makrotask, sodass dieser Zähler währenddessen
  // nie an die Reihe käme.
  function startTicker() {
    const state = { ticks: 0, running: true };
    const tick = () => { if (state.running) { state.ticks += 1; setImmediate(tick); } };
    setImmediate(tick);
    return state;
  }

  it('interleaves event-loop turns while processing a large calendar', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      const ticker = startTicker();
      const OBJECTS = 150; // 3 Batches à YIELD_EVERY=50 → mindestens 2 Yields
      const result = await sync({ createClient: fakeClientFactory(OBJECTS) });
      ticker.running = false;

      assert.strictEqual(result.syncedEvents, OBJECTS, 'alle Objekte upserted');
      const count = d.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
      assert.strictEqual(count, OBJECTS, 'alle Events in der DB');
      assert.ok(
        ticker.ticks >= 2,
        `Event-Loop muss während des Syncs mehrfach dran sein (ticks=${ticker.ticks})`
      );
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('completes a small calendar within a single loop turn (no needless yields)', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      const ticker = startTicker();
      await sync({ createClient: fakeClientFactory(10) }); // < YIELD_EVERY
      ticker.running = false;

      assert.strictEqual(ticker.ticks, 0, 'kleiner Sync yieldet nicht (kein Overhead)');
      const count = d.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
      assert.strictEqual(count, 10, 'alle Events in der DB');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });
});

// --------------------------------------------------------
// #549: Ein CalDAV-Objekt kann den Serien-Master UND geänderte Einzel-Vorkommen
// (RECURRENCE-ID) unter derselben UID enthalten (iOS/Baikal). Ohne
// Normalisierung überschreibt das RRULE-lose Override die Serie -> die
// Wochentags-Wiederholung verschwindet. Dieser Test treibt den echten sync()-Pfad.
// --------------------------------------------------------
describe('CalDAV: RECURRENCE-ID-Overrides killen die Serie nicht (#549)', () => {
  const CALENDAR_URL = 'https://dav.example/cal-1/';

  function buildDb() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT);
      INSERT INTO users (display_name) VALUES ('Owner');
      CREATE TABLE caldav_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, caldav_url TEXT, username TEXT, password TEXT, last_sync TEXT
      );
      CREATE TABLE caldav_calendar_selection (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER, calendar_url TEXT, calendar_name TEXT,
        calendar_color TEXT, enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE external_calendars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT, color TEXT,
        default_assignee_user_id INTEGER, UNIQUE(source, external_id)
      );
      CREATE TABLE calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, description TEXT,
        start_datetime TEXT, end_datetime TEXT, all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT, color TEXT, recurrence_rule TEXT,
        external_calendar_id TEXT, external_source TEXT,
        calendar_ref_id INTEGER, created_by INTEGER,
        user_modified INTEGER NOT NULL DEFAULT 0, assigned_to INTEGER,
        target_caldav_account_id INTEGER, target_caldav_calendar_url TEXT
      );
      CREATE TABLE event_assignments (event_id INTEGER, user_id INTEGER, UNIQUE(event_id, user_id));
      CREATE TABLE calendar_event_exceptions (
        event_id INTEGER NOT NULL, exception_date TEXT NOT NULL,
        PRIMARY KEY (event_id, exception_date)
      );
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
        VALUES ('Baikal', 'https://dav.example/', 'u', 'p');
      INSERT INTO caldav_calendar_selection
        (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (1, '${CALENDAR_URL}', 'Cal 1', '#4A90E2', 1);
    `);
    return d;
  }

  // Master (MO,TU) + verlegtes Di-Vorkommen + Feiertag-EXDATE, alles unter EINER UID.
  const OBJECT_DATA = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:series@x', 'SUMMARY:Schule',
    'DTSTART:20260720T080000Z', 'DTEND:20260720T090000Z',
    'EXDATE:20260803T080000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:series@x', 'SUMMARY:Schule (verlegt)',
    'RECURRENCE-ID:20260721T080000Z',
    'DTSTART:20260721T100000Z', 'DTEND:20260721T110000Z', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const fakeClient = async () => ({
    fetchCalendars:       async () => [{ url: CALENDAR_URL, displayName: 'Cal 1' }],
    fetchCalendarObjects: async () => [{ data: OBJECT_DATA }],
    createCalendarObject: async () => ({}),
  });

  it('behält die Serie (RRULE) und legt Override + EXDATE als eigenständige Daten ab', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      await sync({ createClient: fakeClient });

      const master = d.prepare(
        `SELECT * FROM calendar_events WHERE external_calendar_id = 'series@x'`
      ).get();
      assert.ok(master, 'Master-Zeile existiert');
      assert.ok(master.recurrence_rule && /BYDAY=MO,TU/.test(master.recurrence_rule),
        `RRULE erhalten (kein Collapse): ${master.recurrence_rule}`);
      assert.strictEqual(master.start_datetime.slice(0, 10), '2026-07-20',
        'Master-Start bleibt Mo 20.07.');

      const override = d.prepare(
        `SELECT * FROM calendar_events WHERE external_calendar_id = 'series@x::2026-07-21'`
      ).get();
      assert.ok(override, 'verlegtes Vorkommen als eigenständige Zeile');
      assert.strictEqual(override.recurrence_rule, null, 'Override ist Einzeltermin');
      assert.ok(override.start_datetime.includes('T10:00:00'), 'Override behält seine verlegte Zeit');

      const ex = d.prepare(
        'SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ? ORDER BY exception_date'
      ).all(master.id).map((r) => r.exception_date);
      assert.ok(ex.includes('2026-07-21'), 'Original-Slot des Overrides ausgenommen');
      assert.ok(ex.includes('2026-08-03'), 'EXDATE (Feiertag) übernommen');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  // Selbstheilung: Wer mit der alten (buggy) Version synct hat, hat pro UID EINE
  // kollabierte Zeile (rrule=NULL, start=letztes Override-Datum, UID=bare). Ein
  // Re-Sync mit dem Fix muss daraus wieder die Serie machen (UPDATE trifft die
  // bare-UID-Zeile) und die Overrides als eigene Zeilen ergänzen - ohne verwaiste
  // Reste. Damit ist KEINE Migration/Bereinigung nötig.
  it('repariert eine bereits kollabierte Serie beim nächsten Sync (keine Waisen)', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      // Vorzustand wie nach dem alten Bug: Serie zu Einzeltermin kollabiert.
      d.prepare(`
        INSERT INTO calendar_events
          (title, start_datetime, end_datetime, all_day, recurrence_rule,
           external_calendar_id, external_source, calendar_ref_id, created_by)
        VALUES ('Schule (kaputt)', '2026-07-21T10:00:00Z', '2026-07-21T11:00:00Z', 0,
                NULL, 'series@x', 'caldav', NULL, 1)
      `).run();

      await sync({ createClient: fakeClient });

      const master = d.prepare(
        `SELECT * FROM calendar_events WHERE external_calendar_id = 'series@x'`
      ).get();
      assert.ok(master.recurrence_rule && /BYDAY=MO,TU/.test(master.recurrence_rule),
        `kollabierte Zeile wird zur Serie repariert: ${master.recurrence_rule}`);
      assert.strictEqual(master.start_datetime.slice(0, 10), '2026-07-20',
        'Master-Start wieder Mo 20.07.');

      // Genau eine Zeile pro external_calendar_id - kein verwaister Rest.
      const rows = d.prepare(
        `SELECT external_calendar_id, COUNT(*) AS n FROM calendar_events GROUP BY external_calendar_id`
      ).all();
      for (const r of rows) assert.strictEqual(r.n, 1, `keine Duplikate für ${r.external_calendar_id}`);
      const ids = rows.map((r) => r.external_calendar_id).sort();
      assert.deepStrictEqual(ids, ['series@x', 'series@x::2026-07-21'],
        `Master + genau ein Override, keine Waisen: ${ids.join()}`);
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });
});
