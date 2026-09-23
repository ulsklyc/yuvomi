/**
 * Test: CalDAV Multi-Account Sync
 * Purpose: Verify CalDAV multi-account functionality
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { toICSDatetime, sync, getCalendars, updateAccount, updateCalendarSelection, deleteAccount, countAccountEvents, addAccount } from '../server/services/caldav-sync.js';
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
      -- Die Frist der Farb-Heilung (#1270) liegt hier.
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        title                       TEXT NOT NULL,
        external_calendar_id        TEXT,
        external_source             TEXT,
        -- Die Farbe und ihr Zustand: der Upload traegt sie hinaus und merkt
        -- sich, dass sie unsere ist (#899).
        color                       TEXT,
        color_modified              INTEGER NOT NULL DEFAULT 0,
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
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

      -- Die Frist der Farb-Heilung (#1270) liegt hier.
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, description TEXT,
        start_datetime TEXT, end_datetime TEXT, all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT, color TEXT, recurrence_rule TEXT, tzid TEXT,
        external_calendar_id TEXT, external_source TEXT,
        calendar_ref_id INTEGER, created_by INTEGER,
        user_modified INTEGER NOT NULL DEFAULT 0, assigned_to INTEGER,
        -- Der eigene Zustand der Farbe (#899, Migration v167): das Farb-Gatter
        -- des Inbound haengt daran, nicht mehr an user_modified.
        color_modified INTEGER NOT NULL DEFAULT 0,
        target_caldav_account_id INTEGER, target_caldav_calendar_url TEXT,
        -- Ausgehende Vormerkungen (#593, Migrationen v104-v106)
        outbound_dirty INTEGER NOT NULL DEFAULT 0,
        outbound_attempts INTEGER NOT NULL DEFAULT 0,
        outbound_move_to TEXT,
        external_object_url TEXT
      );
      CREATE TABLE calendar_pending_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        calendar_external_id TEXT NOT NULL,
        event_external_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        object_url TEXT,
        UNIQUE(source, calendar_external_id, event_external_id)
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
  //
  // Ein Beobachter darf das beobachtete System nicht am Leben halten (#903):
  // ein sich selbst neu planender `setImmediate` hält den Event-Loop ganz
  // allein offen. Stand das Abschalten hinter dem `await sync(...)`, wurde es
  // bei einem Throw nie erreicht - die Suite meldete ihr `✖`, aber nie ihr
  // Ende: kein Summary, kein Exit-Code, `npm test` stand still statt rot zu
  // werden. Deshalb beides: `unref()` nimmt dem Timer das Recht, den Prozess
  // offenzuhalten, und `stop()` gehört in ein `finally`, nicht dahinter.
  function startTicker() {
    const state = { ticks: 0, running: true };
    const schedule = (fn) => { setImmediate(fn).unref(); };
    const tick = () => { if (state.running) { state.ticks += 1; schedule(tick); } };
    schedule(tick);
    state.stop = () => { state.running = false; };
    return state;
  }

  it('interleaves event-loop turns while processing a large calendar', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    const ticker = startTicker();
    try {
      const OBJECTS = 150; // 3 Batches à YIELD_EVERY=50 → mindestens 2 Yields
      const result = await sync({ createClient: fakeClientFactory(OBJECTS) });
      const ticks = ticker.ticks; // Momentaufnahme am Sync-Ende

      assert.strictEqual(result.syncedEvents, OBJECTS, 'alle Objekte upserted');
      const count = d.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
      assert.strictEqual(count, OBJECTS, 'alle Events in der DB');
      assert.ok(
        ticks >= 2,
        `Event-Loop muss während des Syncs mehrfach dran sein (ticks=${ticks})`
      );
    } finally {
      ticker.stop();
      _resetTestDatabase();
      d.close();
    }
  });

  it('completes a small calendar within a single loop turn (no needless yields)', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    const ticker = startTicker();
    try {
      await sync({ createClient: fakeClientFactory(10) }); // < YIELD_EVERY
      const ticks = ticker.ticks; // Momentaufnahme am Sync-Ende

      assert.strictEqual(ticks, 0, 'kleiner Sync yieldet nicht (kein Overhead)');
      const count = d.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
      assert.strictEqual(count, 10, 'alle Events in der DB');
    } finally {
      ticker.stop();
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
      -- Die Frist der Farb-Heilung (#1270) liegt hier.
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, description TEXT,
        start_datetime TEXT, end_datetime TEXT, all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT, color TEXT, recurrence_rule TEXT, tzid TEXT,
        external_calendar_id TEXT, external_source TEXT,
        calendar_ref_id INTEGER, created_by INTEGER,
        user_modified INTEGER NOT NULL DEFAULT 0, assigned_to INTEGER,
        -- Der eigene Zustand der Farbe (#899, Migration v167): das Farb-Gatter
        -- des Inbound haengt daran, nicht mehr an user_modified.
        color_modified INTEGER NOT NULL DEFAULT 0,
        target_caldav_account_id INTEGER, target_caldav_calendar_url TEXT,
        -- Ausgehende Vormerkungen (#593, Migrationen v104-v106)
        outbound_dirty INTEGER NOT NULL DEFAULT 0,
        outbound_attempts INTEGER NOT NULL DEFAULT 0,
        outbound_move_to TEXT,
        external_object_url TEXT
      );
      CREATE TABLE calendar_pending_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        calendar_external_id TEXT NOT NULL,
        event_external_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        object_url TEXT,
        UNIQUE(source, calendar_external_id, event_external_id)
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

// --------------------------------------------------------
// No-op-Sync-Pfade laufen bei jedem Scheduler-Tick durch. Sie dürfen im
// Standard-Log-Level (info) nichts ausgeben, sonst füllt der Scheduler das
// Log mit Meldungen über Zustände, die schlicht der Normalfall sind.
// --------------------------------------------------------
describe('CalDAV: No-op-Syncs bleiben im Standard-Log-Level still', () => {
  // Fängt alle console-Kanäle ab. Der Logger schreibt debug über console.log
  // und info über console.info (server/logger.js) - ein leerer info-Kanal
  // beweist also, dass die Meldung unterhalb des Standard-Levels bleibt.
  async function captureConsole(fn) {
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const lines = { log: [], info: [], warn: [], error: [] };
    for (const level of Object.keys(original)) {
      console[level] = (...args) => lines[level].push(args.join(' '));
    }
    try {
      await fn();
    } finally {
      Object.assign(console, original);
    }
    return lines;
  }

  function buildDb() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT);
      INSERT INTO users (display_name) VALUES ('Owner');

      -- Die Frist der Farb-Heilung (#1270) liegt hier.
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, description TEXT,
        start_datetime TEXT, end_datetime TEXT, all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT, color TEXT, recurrence_rule TEXT, tzid TEXT,
        external_calendar_id TEXT, external_source TEXT,
        calendar_ref_id INTEGER, created_by INTEGER,
        user_modified INTEGER NOT NULL DEFAULT 0, assigned_to INTEGER,
        -- Der eigene Zustand der Farbe (#899, Migration v167): das Farb-Gatter
        -- des Inbound haengt daran, nicht mehr an user_modified.
        color_modified INTEGER NOT NULL DEFAULT 0,
        target_caldav_account_id INTEGER, target_caldav_calendar_url TEXT,
        outbound_dirty INTEGER NOT NULL DEFAULT 0,
        outbound_attempts INTEGER NOT NULL DEFAULT 0,
        outbound_move_to TEXT,
        external_object_url TEXT
      );
      CREATE TABLE calendar_pending_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        calendar_external_id TEXT NOT NULL,
        event_external_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        object_url TEXT,
        UNIQUE(source, calendar_external_id, event_external_id)
      );
      CREATE TABLE event_assignments (
        event_id INTEGER, user_id INTEGER, UNIQUE(event_id, user_id)
      );
      CREATE TABLE calendar_event_exceptions (
        event_id INTEGER NOT NULL, exception_date TEXT NOT NULL,
        PRIMARY KEY (event_id, exception_date)
      );
    `);
    return d;
  }

  it('sagt nichts, wenn gar kein Account konfiguriert ist', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      const lines = await captureConsole(async () => {
        const res = await sync();
        assert.deepStrictEqual(res, { success: true, syncedAccounts: 0, syncedEvents: 0 });
      });
      assert.deepStrictEqual(lines.info, []);
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('sagt nichts, wenn ein Account keine aktivierten Kalender hat', async () => {
    const d = buildDb();
    d.exec(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
              VALUES ('Radicale', 'https://dav.example/', 'u', 'p');`);
    _setTestDatabase(d);
    try {
      let clientCalls = 0;
      const createClient = async () => {
        clientCalls++;
        return {
          fetchCalendars:       async () => [],
          fetchCalendarObjects: async () => [],
          createCalendarObject: async () => ({}),
        };
      };
      const lines = await captureConsole(async () => {
        const res = await sync({ createClient });
        assert.strictEqual(res.syncedEvents, 0);
      });
      // Positivkontrolle ohne Umweg über das Log: die Account-Schleife lief
      // wirklich, der Skip-Pfad wurde also erreicht statt übersprungen.
      assert.strictEqual(clientCalls, 1, 'Account-Schleife wurde nicht durchlaufen');
      assert.deepStrictEqual(lines.info, []);
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  // Gegenprobe: der Sync darf nicht pauschal verstummen. Sobald er wirklich
  // Events verarbeitet, gehört die Zusammenfassung ins Standard-Log.
  it('meldet den Abschluss auf info, sobald Events verarbeitet wurden', async () => {
    const CALENDAR_URL = 'https://dav.example/cal-1/';
    const d = buildDb();
    d.exec(`
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
        VALUES ('Radicale', 'https://dav.example/', 'u', 'p');
      INSERT INTO caldav_calendar_selection
        (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (1, '${CALENDAR_URL}', 'Cal 1', '#4A90E2', 1);
    `);
    _setTestDatabase(d);
    try {
      const createClient = async () => ({
        fetchCalendars:       async () => [{ url: CALENDAR_URL, displayName: 'Cal 1' }],
        fetchCalendarObjects: async () => [{
          data: [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
            'UID:evt-1@test', 'SUMMARY:Event 1',
            'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z',
            'END:VEVENT', 'END:VCALENDAR',
          ].join('\r\n'),
        }],
        createCalendarObject: async () => ({}),
      });
      const lines = await captureConsole(async () => {
        const res = await sync({ createClient });
        assert.strictEqual(res.syncedEvents, 1);
      });
      assert.ok(
        lines.info.some((l) => l.includes('CalDAV sync complete: 1/1 accounts, 1 events')),
        `Zusammenfassung fehlt im Standard-Log: ${JSON.stringify(lines.info)}`
      );
      // Und zwar genau diese eine Zeile: der Fortschritt pro Account und die
      // Detailbilanz gehören ins Debug-Log, nicht in jeden Scheduler-Tick.
      assert.strictEqual(
        lines.info.length, 1,
        `nur die Zusammenfassung gehört auf info: ${JSON.stringify(lines.info)}`
      );
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  // --- Wiederholte Läufe über unveränderte Termine ---------------------------
  // Der Regelfall im Betrieb: der Scheduler ruft denselben Kalender immer
  // wieder ab, ohne dass sich etwas geändert hat.

  const CALENDAR_URL = 'https://dav.example/cal-1/';

  function seedAccountWithCalendar(d) {
    d.exec(`
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
        VALUES ('Radicale', 'https://dav.example/', 'u', 'p');
      INSERT INTO caldav_calendar_selection
        (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (1, '${CALENDAR_URL}', 'Cal 1', '#4A90E2', 1);
    `);
  }

  // Client, der einen einzelnen Termin mit steuerbarem Titel liefert.
  function clientWith(summary) {
    return async () => ({
      fetchCalendars:       async () => [{ url: CALENDAR_URL, displayName: 'Cal 1' }],
      fetchCalendarObjects: async () => [{
        data: [
          'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
          'UID:evt-1@test', `SUMMARY:${summary}`,
          'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z',
          'END:VEVENT', 'END:VCALENDAR',
        ].join('\r\n'),
      }],
      createCalendarObject: async () => ({}),
    });
  }

  it('bleibt still, wenn ein zweiter Lauf denselben Termin unverändert sieht', async () => {
    const d = buildDb();
    seedAccountWithCalendar(d);
    _setTestDatabase(d);
    try {
      const createClient = clientWith('Event 1');
      await captureConsole(() => sync({ createClient })); // erster Lauf legt an

      const lines = await captureConsole(async () => {
        const res = await sync({ createClient });
        // Der Termin wird weiterhin gesehen, er ändert nur nichts mehr.
        assert.strictEqual(res.syncedEvents, 1);
      });
      assert.deepStrictEqual(lines.info, [], 'unveränderter Lauf muss schweigen');
      const row = d.prepare('SELECT COUNT(*) AS n FROM calendar_events').get();
      assert.strictEqual(row.n, 1, 'kein Duplikat angelegt');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  // Gegenprobe zur WHERE-Klausel: sie darf echte Änderungen nicht wegfiltern.
  // Ein falsches Negativ hier wäre Datenverlust, nicht bloß fehlendes Logging.
  it('übernimmt und meldet einen Termin, dessen Titel sich geändert hat', async () => {
    const d = buildDb();
    seedAccountWithCalendar(d);
    _setTestDatabase(d);
    try {
      await captureConsole(() => sync({ createClient: clientWith('Event 1') }));

      const lines = await captureConsole(() =>
        sync({ createClient: clientWith('Event 1 geändert') })
      );
      assert.ok(
        lines.info.some((l) => l.includes('1 events seen, 1 changed')),
        `Änderung nicht gemeldet: ${JSON.stringify(lines.info)}`
      );
      const row = d.prepare('SELECT title FROM calendar_events').get();
      assert.strictEqual(row.title, 'Event 1 geändert', 'Änderung nicht übernommen');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });
});

// --------------------------------------------------------
// Das Farb-Gatter des Inbound haengt an color_modified (#899)
// --------------------------------------------------------

describe('CalDAV: eine Bearbeitung friert die Farbe nicht mehr ein (#899)', () => {
  const CALENDAR_URL = 'https://dav.example/cal-1/';

  function buildDb() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT);
      INSERT INTO users (display_name) VALUES ('Owner');

      -- Die Frist der Farb-Heilung (#1270) liegt hier.
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, description TEXT,
        start_datetime TEXT, end_datetime TEXT, all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT, color TEXT, recurrence_rule TEXT, tzid TEXT,
        external_calendar_id TEXT, external_source TEXT,
        calendar_ref_id INTEGER, created_by INTEGER,
        user_modified INTEGER NOT NULL DEFAULT 0, assigned_to INTEGER,
        color_modified INTEGER NOT NULL DEFAULT 0,
        target_caldav_account_id INTEGER, target_caldav_calendar_url TEXT,
        outbound_dirty INTEGER NOT NULL DEFAULT 0,
        outbound_attempts INTEGER NOT NULL DEFAULT 0,
        outbound_move_to TEXT,
        external_object_url TEXT
      );
      CREATE TABLE calendar_pending_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, calendar_external_id TEXT NOT NULL,
        event_external_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        object_url TEXT,
        UNIQUE(source, calendar_external_id, event_external_id)
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

  // Derselbe Termin, wahlweise mit COLOR-Zeile - so faerbt ihn ein anderer
  // Client auf dem Server ein, ohne dass in Yuvomi jemand etwas tut.
  function clientWith({ color = null } = {}) {
    return async () => ({
      fetchCalendars:       async () => [{ url: CALENDAR_URL, displayName: 'Cal 1' }],
      fetchCalendarObjects: async () => [{
        url: `${CALENDAR_URL}evt-1.ics`,
        data: [
          'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
          'UID:evt-1@test', 'SUMMARY:Zahnarzt',
          ...(color ? [`COLOR:${color}`] : []),
          'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z',
          'END:VEVENT', 'END:VCALENDAR',
        ].join('\r\n'),
      }],
      createCalendarObject: async () => ({}),
    });
  }

  const row = (d) => d.prepare(
    `SELECT color, user_modified, color_modified FROM calendar_events WHERE external_calendar_id = 'evt-1@test'`
  ).get();

  it('lernt die Farbe des Servers auch nach einer Titelaenderung', async () => {
    // Der Repro aus #899, Schritt fuer Schritt: Termin kommt ohne COLOR herein,
    // der Nutzer aendert in Yuvomi nur den TITEL (das setzt user_modified = 1),
    // danach faerbt ihn jemand in Nextcloud ein. Solange das Farb-Gatter an
    // user_modified hing, kam diese Farbe nie an - dauerhaft.
    const d = buildDb();
    _setTestDatabase(d);
    try {
      await sync({ createClient: clientWith() });
      assert.strictEqual(row(d).color, null, 'Vorbedingung: keine Eigenfarbe');

      d.prepare(`UPDATE calendar_events SET title = 'Zahnarzt (verschoben)', user_modified = 1`).run();

      await sync({ createClient: clientWith({ color: 'tomato' }) });
      const after = row(d);
      assert.strictEqual(after.color, '#FF6347', 'die Farbe des Servers muss ankommen');
      assert.strictEqual(after.user_modified, 1, 'die Bearbeitung selbst bleibt vermerkt');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('laesst eine lokal gewaehlte Farbe (color_modified = 1) in Ruhe', async () => {
    // Die Gegenprobe, und der Grund, warum das Gatter ueberhaupt existiert:
    // ohne sie waere der Test darueber auch dann gruen, wenn der Inbound die
    // Farbspalte gar nicht mehr schuetzt.
    const d = buildDb();
    _setTestDatabase(d);
    try {
      await sync({ createClient: clientWith() });
      d.prepare(`UPDATE calendar_events SET color = '#7C3AED', color_modified = 1`).run();

      await sync({ createClient: clientWith({ color: 'tomato' }) });
      assert.strictEqual(row(d).color, '#7C3AED', 'die eigene Farbe darf nicht ueberschrieben werden');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('ein hochgeladener Termin behaelt danach seine exakte Farbe', async () => {
    // Der dritte Befund aus #899: der Upload schreibt die Farbe als CSS3-NAMEN
    // hinaus (#7C3AED wird zu blueviolet, #8A2BE2). Ohne das Flag holte der
    // naechste Inbound-Lauf genau den zurueck und ersetzte den gewaehlten Wert
    // durch den gerundeten. Geprueft wird das Flag, nicht die Runde danach -
    // es ist die Ursache, und der Lauf danach ist schon oben abgedeckt.
    const d = buildDb();
    d.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, color, external_source, created_by,
         target_caldav_account_id, target_caldav_calendar_url)
      VALUES ('Eigener Termin', '2026-02-01T09:00', '2026-02-01T10:00', '#7C3AED', 'local', 1, 1, ?)
    `).run(CALENDAR_URL);
    d.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, color, external_source, created_by,
         target_caldav_account_id, target_caldav_calendar_url)
      VALUES ('Farbloser Termin', '2026-02-01T09:00', '2026-02-01T10:00', NULL, 'local', 1, 1, ?)
    `).run(CALENDAR_URL);
    _setTestDatabase(d);
    try {
      await sync({ createClient: clientWith() });

      const uploaded = d.prepare(
        `SELECT color_modified FROM calendar_events WHERE title = 'Eigener Termin'`
      ).get();
      assert.strictEqual(uploaded.color_modified, 1, 'die hinausgeschickte Farbe gehoert uns');

      // Ohne Eigenfarbe ist nichts hinausgegangen, was zu verteidigen waere:
      // der Termin darf die Farbe des Servers weiterhin lernen.
      const colourless = d.prepare(
        `SELECT color_modified FROM calendar_events WHERE title = 'Farbloser Termin'`
      ).get();
      assert.strictEqual(colourless.color_modified, 0, 'ohne Farbe bleibt der Zustand offen');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });
});

// --------------------------------------------------------
// Eingebrannte Kalenderfarbe aus der Zeit vor #891 (#1270)
// --------------------------------------------------------

describe('CalDAV: die eingebrannte Kalenderfarbe loest sich (#1270)', () => {
  // Kalender-Home von Konto 1 und Konto 2 (Nextcloud-/Radicale-Form).
  const HOME_1 = 'https://dav.example/calendars/u1/';
  const HOME_2 = 'https://dav.example/calendars/u2/';
  const CAL_A = `${HOME_1}a/`;
  const CAL_B = `${HOME_1}b/`;
  const CAL_C = `${HOME_2}c/`;
  const COLOR_A = '#4A90E2';
  const COLOR_B = '#E24A4A';
  const COLOR_C = '#8156C0';
  const UID = 'series-1@test';
  const HEAL_KEY_1 = 'caldav_legacy_color_heal_since_1';

  function buildDb() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT);
      INSERT INTO users (display_name) VALUES ('Owner');

      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, description TEXT,
        start_datetime TEXT, end_datetime TEXT, all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT, color TEXT, recurrence_rule TEXT, tzid TEXT,
        external_calendar_id TEXT, external_source TEXT,
        calendar_ref_id INTEGER, created_by INTEGER,
        user_modified INTEGER NOT NULL DEFAULT 0, assigned_to INTEGER,
        color_modified INTEGER NOT NULL DEFAULT 0,
        target_caldav_account_id INTEGER, target_caldav_calendar_url TEXT,
        outbound_dirty INTEGER NOT NULL DEFAULT 0,
        outbound_attempts INTEGER NOT NULL DEFAULT 0,
        outbound_move_to TEXT,
        external_object_url TEXT
      );
      CREATE TABLE calendar_pending_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, calendar_external_id TEXT NOT NULL,
        event_external_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        object_url TEXT,
        UNIQUE(source, calendar_external_id, event_external_id)
      );
      CREATE TABLE event_assignments (
        event_id INTEGER, user_id INTEGER, UNIQUE(event_id, user_id)
      );
      CREATE TABLE calendar_event_exceptions (
        event_id INTEGER NOT NULL, exception_date TEXT NOT NULL,
        PRIMARY KEY (event_id, exception_date)
      );

      INSERT INTO caldav_accounts (name, caldav_url, username, password)
        VALUES ('Radicale', 'https://dav.example/', 'u1', 'p');
      INSERT INTO caldav_calendar_selection
        (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (1, '${CAL_A}', 'A', '${COLOR_A}', 1),
               (1, '${CAL_B}', 'B', '${COLOR_B}', 1);
    `);
    return d;
  }

  function vevent({ color = null, recurrenceId = null, start = '20260105T170000Z' } = {}) {
    return [
      'BEGIN:VEVENT', `UID:${UID}`, 'SUMMARY:Training',
      ...(color ? [`COLOR:${color}`] : []),
      ...(recurrenceId ? [`RECURRENCE-ID:${recurrenceId}`] : ['RRULE:FREQ=WEEKLY']),
      `DTSTART:${start}`, 'DTEND:20260105T180000Z',
      'END:VEVENT',
    ];
  }

  // Die Serie liegt in `inCal`, alle anderen Kalender sind leer. So sieht der
  // Umzug von A nach B aus, den Kyrodan in einem anderen Client gemacht hat:
  // gleiche UID, anderer Kalender.
  function clientWith({ inCal, color = null, override = false, calendars = [CAL_A, CAL_B, CAL_C] }) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevent({ color })];
    if (override) lines.push(...vevent({ recurrenceId: '20260112T170000Z', start: '20260112T190000Z' }));
    lines.push('END:VCALENDAR');
    const ics = lines.join('\r\n');
    return async () => ({
      fetchCalendars: async () => calendars.map((url) => ({ url, displayName: url })),
      fetchCalendarObjects: async ({ calendar }) =>
        (calendar.url === inCal ? [{ url: `${inCal}series-1.ics`, data: ics }] : []),
      createCalendarObject: async () => ({}),
    });
  }

  const row = (d, uid = UID) => d.prepare(`
    SELECT e.color, e.color_modified, e.outbound_dirty, ec.external_id AS cal
    FROM calendar_events e LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
    WHERE e.external_calendar_id = ?
  `).get(uid);
  // Stand der Farb-Heilung eines Kontos: null (Frist noch nicht begonnen),
  // 'never' oder der Beginn der Frist.
  const healState = (d, key = HEAL_KEY_1) => d.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
  const ISO = /^\d{4}-\d{2}-\d{2}T/;

  // Der Stand einer Bestandsinstallation direkt nach dem Update: vor v2.49.0
  // schrieb der Import die Kalenderfarbe in die Eigenfarb-Spalte, Migration
  // 167 hat jede bearbeitete Zeile als "lokal umgefaerbt" uebernommen, und die
  // Frist der Heilung hat noch nicht begonnen.
  function legacyState(d, color, uid = UID) {
    d.prepare(`UPDATE calendar_events SET color = ?, user_modified = 1, color_modified = 1
               WHERE external_calendar_id = ?`).run(color, uid);
    d.prepare('DELETE FROM sync_config').run();
  }

  async function withDb(fn) {
    const d = buildDb();
    // `node:sqlite` kennt kein `.transaction()`; addAccount und deleteAccount
    // brauchen eines. Derselbe Shim wie im Block zum Aufraeumen (#732).
    d.transaction = (fn2) => (...args) => {
      d.exec('BEGIN');
      try { const out = fn2(...args); d.exec('COMMIT'); return out; }
      catch (err) { d.exec('ROLLBACK'); throw err; }
    };
    _setTestDatabase(d);
    try { await fn(d); } finally { _resetTestDatabase(); d.close(); }
  }

  it('der Umzug nach B loest die eingebrannte Farbe von A', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);

    await sync({ createClient: clientWith({ inCal: CAL_B }) });
    const after = row(d);
    assert.strictEqual(after.cal, CAL_B, 'Vorbedingung: der Kalender ist mitgezogen');
    assert.strictEqual(after.color, null, 'die Farbe von A ist geerbt, keine Eigenfarbe');
    assert.strictEqual(after.color_modified, 0, 'der Server fuehrt die Farbe wieder');
    assert.strictEqual(after.outbound_dirty, 0, 'die Heilung schickt nichts hinaus');
    assert.match(healState(d), ISO, 'der erste Lauf hat die Frist begonnen');
  }));

  it('auch ohne Umzug und unabhaengig von der Schreibweise', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A.toLowerCase());

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, null);
  }));

  it('heilt ueber die Auswahl allein: ein nie synchronisierter Kalender des Kontos', () => withDb(async (d) => {
    // B ist abgewaehlt und stand deshalb nie in external_calendars - seine
    // Farbe kennt NUR die Auswahl des Kontos.
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 0 WHERE calendar_url = ?').run(CAL_B);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(
      d.prepare("SELECT COUNT(*) AS n FROM external_calendars WHERE external_id = ?").get(CAL_B).n, 0,
      'Vorbedingung: B steht nicht in external_calendars'
    );
    legacyState(d, COLOR_B);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, null);
  }));

  it('heilt ueber external_calendars allein: der alte Kalender ist auf dem Server geloescht', () => withDb(async (d) => {
    // Kyrodans Weg zu Ende gedacht: Termine von A nach B umgezogen, A danach
    // aufgegeben. Beim Aktualisieren faellt A aus der Auswahl, seine Farbe
    // steht nur noch in external_calendars - im Kalender-Home des Kontos.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.prepare('DELETE FROM caldav_calendar_selection WHERE calendar_url = ?').run(CAL_A);

    await sync({ createClient: clientWith({ inCal: CAL_B, calendars: [CAL_B] }) });
    const after = row(d);
    assert.strictEqual(after.cal, CAL_B);
    assert.strictEqual(after.color, null);
  }));

  it('die Kalenderfarbe eines anderen Kontos heilt nichts (Auswahl des fremden Kontos)', () => withDb(async (d) => {
    // Konto 2 fuehrt C im SELBEN Kalender-Home wie Konto 1 (etwa ein geteilter
    // Kalender). Er steht in der Auswahl von Konto 2 und gehoert damit dorthin.
    const CAL_SHARED = `${HOME_1}shared/`;
    d.exec(`
      INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Zweit', 'https://dav.example/', 'u2', 'p');
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (2, '${CAL_SHARED}', 'C', '${COLOR_C}', 1);
    `);
    await sync({ createClient: clientWith({ inCal: CAL_A, calendars: [CAL_A, CAL_B, CAL_SHARED] }) });
    legacyState(d, COLOR_C);

    await sync({ createClient: clientWith({ inCal: CAL_A, calendars: [CAL_A, CAL_B, CAL_SHARED] }) });
    assert.strictEqual(row(d).color, COLOR_C, 'eine bewusst gewaehlte Farbe bleibt');
  }));

  it('die Kalenderfarbe eines anderen Kontos heilt nichts (fremdes Kalender-Home)', () => withDb(async (d) => {
    // C lag in Konto 2 und ist dort aus der Auswahl gefallen: nur noch
    // external_calendars kennt ihn, und nichts nennt dort sein Konto.
    d.exec(`
      INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav', '${CAL_C}', 'C', '${COLOR_C}');
    `);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_C);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_C, 'eine bewusst gewaehlte Farbe bleibt');
  }));

  it('zaehlt eine reine Heilung als Aenderung', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);

    const info = [];
    const original = console.info;
    console.info = (...args) => info.push(args.join(' '));
    try {
      await sync({ createClient: clientWith({ inCal: CAL_A }) });
    } finally {
      console.info = original;
    }
    assert.ok(
      info.some((l) => l.includes('1 events seen, 1 changed')),
      `Heilung nicht als Aenderung gemeldet: ${JSON.stringify(info)}`
    );
  }));

  it('heilt auch ein geaendertes Einzelvorkommen (RECURRENCE-ID)', () => withDb(async (d) => {
    const OVERRIDE_UID = `${UID}::2026-01-12`;
    await sync({ createClient: clientWith({ inCal: CAL_A, override: true }) });
    assert.ok(row(d, OVERRIDE_UID), 'Vorbedingung: das Vorkommen ist eine eigene Zeile');
    legacyState(d, COLOR_A, OVERRIDE_UID);

    await sync({ createClient: clientWith({ inCal: CAL_B, override: true }) });
    assert.strictEqual(row(d, OVERRIDE_UID).color, null);
  }));

  // Verbindungstest von addAccount: meldet die Kalender mit ihren Farben.
  const accountClient = (urls) => async () => ({
    fetchCalendars: async () => urls.map((url) => ({
      url, displayName: url, components: ['VEVENT'],
      calendarColor: url === CAL_A ? COLOR_A : url === CAL_B ? COLOR_B : COLOR_C,
    })),
  });

  it('ein wirklich neues Konto ohne Altzeilen wird uebersprungen', () => withDb(async (d) => {
    // Ein Konto, das es vor v2.50 nicht gab, kann keine eingebrannte Farbe
    // tragen. Eine Farbe dort ist eine gewaehlte, auch wenn sie zufaellig der
    // Kalenderfarbe gleicht (etwa ein hochgeladener Termin mit Palettenfarbe,
    // dessen COLOR-Zeile der Server nicht aufbewahrt).
    d.exec('DELETE FROM caldav_calendar_selection; DELETE FROM caldav_accounts;');
    const { accountId } = await addAccount('Neu', 'https://dav.example/', 'u3', 'p', { createClient: accountClient([CAL_A]) });
    assert.strictEqual(healState(d, `caldav_legacy_color_heal_since_${accountId}`), 'never',
      'ohne Altzeilen gilt das Konto gleich als erledigt');
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 1').run();
    d.prepare(`
      INSERT INTO calendar_events (title, start_datetime, external_calendar_id, external_source, color, color_modified, created_by)
      VALUES ('Training', '2026-01-05T17:00:00Z', ?, 'caldav', ?, 1, 1)
    `).run(UID, COLOR_A);

    await sync({ createClient: clientWith({ inCal: CAL_A, calendars: [CAL_A] }) });
    assert.strictEqual(row(d).color, COLOR_A, 'die gewaehlte Farbe bleibt');
  }));

  it('ein geloeschtes und wieder angelegtes Konto heilt die uebernommenen Zeilen', () => withDb(async (d) => {
    // Der Weg eines Betroffenen: Konto loeschen (die Termine bleiben stehen)
    // und neu anlegen - UNIQUE(caldav_url, username) laesst nichts anderes zu.
    // Der Inbound uebernimmt die alten Zeilen per UID samt eingebrannter
    // Farbe. Dazu Kyrodans Umzug: der alte Kalender A ist auf dem Server weg,
    // der Termin liegt in B, und die Zeile zeigt noch auf A - ein Abgleich
    // gegen die Kalender-URLs des neuen Kontos saehe sie nicht.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    // Was deleteAccount(1) ohne deleteEvents an diesen Tabellen tut: das Konto
    // und per CASCADE seine Auswahl gehen, die Termine bleiben. (Der Aufruf
    // selbst braucht die Aufgaben-Tabellen, die diese Fixture nicht hat.)
    d.exec('DELETE FROM caldav_calendar_selection WHERE account_id = 1; DELETE FROM caldav_accounts WHERE id = 1;');

    const { accountId } = await addAccount('Wieder', 'https://dav.example/', 'u1', 'p', { createClient: accountClient([CAL_B]) });
    assert.strictEqual(healState(d, `caldav_legacy_color_heal_since_${accountId}`), null,
      'mit Altzeilen ohne lebendes Konto steht die Heilung noch aus');
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 1').run();

    await sync({ createClient: clientWith({ inCal: CAL_B, calendars: [CAL_B] }) });
    const after = row(d);
    assert.strictEqual(after.cal, CAL_B, 'Vorbedingung: der Inbound hat die Zeile uebernommen');
    assert.strictEqual(after.color, null, 'die eingebrannte Farbe von A ist weg');
    assert.match(healState(d, `caldav_legacy_color_heal_since_${accountId}`), ISO);
  }));

  it('wieder angelegt, der alte Kalender lebt noch: die Altzeile heilt trotzdem', () => withDb(async (d) => {
    // Der schlichte Fall ohne Umzug. Er haelt die REIHENFOLGE in addAccount
    // fest: die Suche nach Altzeilen muss VOR dem Eintrag der neuen Auswahl
    // laufen - danach haengt die Zeile scheinbar an einem lebenden Konto (dem
    // neuen), und die Heilung liefe dort nie.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.exec('DELETE FROM caldav_calendar_selection WHERE account_id = 1; DELETE FROM caldav_accounts WHERE id = 1;');

    const { accountId } = await addAccount('Wieder', 'https://dav.example/', 'u1', 'p', { createClient: accountClient([CAL_A, CAL_B]) });
    assert.strictEqual(healState(d, `caldav_legacy_color_heal_since_${accountId}`), null);
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 1').run();

    await sync({ createClient: clientWith({ inCal: CAL_A, calendars: [CAL_A, CAL_B] }) });
    const after = row(d);
    assert.strictEqual(after.color, null);
    assert.strictEqual(after.color_modified, 0);
  }));

  it('eine Altzeile ganz ohne Kalenderzuordnung zaehlt auch als verwaist', () => withDb(async (d) => {
    // calendar_ref_id NULL: der LEFT JOIN findet keinen Kalender. Auch so eine
    // Zeile laesst die Heilung beim Anlegen offen; der erste Lauf beginnt die
    // Frist und heilt sie. Ein lebendes Nachbarkonto muss dabei sein: gegen
    // eine LEERE Auswahl ist auch `NULL NOT IN (...)` wahr, und der Test
    // saehe den NULL-Zweig gar nicht.
    d.exec(`
      DELETE FROM caldav_calendar_selection; DELETE FROM caldav_accounts;
      INSERT INTO caldav_accounts (id, name, caldav_url, username, password) VALUES (2, 'Nachbar', 'https://dav.example/', 'u2', 'p');
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (2, '${CAL_C}', 'C', '${COLOR_C}', 0);
    `);
    d.prepare(`
      INSERT INTO calendar_events (title, start_datetime, external_calendar_id, external_source, calendar_ref_id, color, color_modified, user_modified, created_by)
      VALUES ('Training', '2026-01-05T17:00:00Z', ?, 'caldav', NULL, ?, 1, 1, 1)
    `).run(UID, COLOR_A);

    const { accountId } = await addAccount('Wieder', 'https://dav.example/', 'u1', 'p', { createClient: accountClient([CAL_A]) });
    const key = `caldav_legacy_color_heal_since_${accountId}`;
    assert.strictEqual(healState(d, key), null, 'die Zeile ohne Kalender ist eine Altzeile');
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 1').run();

    await sync({ createClient: clientWith({ inCal: CAL_A, calendars: [CAL_A] }) });
    assert.strictEqual(row(d).color, null);
    assert.match(healState(d, key), ISO, 'der erste Lauf beginnt die Frist');
  }));

  it('scheitert das Anlegen, bleibt weder Konto noch Heilungs-Eintrag zurueck', () => withDb(async (d) => {
    // Konto, Auswahl und Heilungs-Entscheidung stehen in EINER Transaktion:
    // scheitert der Eintrag eines Kalenders, darf kein halbes Konto samt Eintrag liegen
    // bleiben, der ihm spaeter die Heilung abschneidet.
    d.exec(`
      DELETE FROM caldav_calendar_selection; DELETE FROM caldav_accounts;
      CREATE TRIGGER boom BEFORE INSERT ON caldav_calendar_selection
        BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    await assert.rejects(
      addAccount('Neu', 'https://dav.example/', 'u3', 'p', { createClient: accountClient([CAL_A]) }),
      /boom/
    );
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM caldav_accounts').get().n, 0, 'kein Konto');
    assert.strictEqual(
      d.prepare("SELECT COUNT(*) AS n FROM sync_config WHERE key LIKE 'caldav_legacy_color_heal_%'").get().n, 0,
      'kein Heilungs-Eintrag'
    );
  }));

  // Freier Client: beliebige Objekte je Kalender und Komponenten je Kalender.
  // `objects`: Kalender-URL -> Liste von ICS-Texten; `components`: URL -> Liste.
  function rawClient({ calendars = [CAL_A, CAL_B], objects = {}, components = {} } = {}) {
    return async () => ({
      fetchCalendars: async () => calendars.map((url) => ({
        url, displayName: url, ...(components[url] ? { components: components[url] } : {}),
      })),
      fetchCalendarObjects: async ({ calendar }) =>
        (objects[calendar.url] || []).map((data, i) => ({ url: `${calendar.url}obj-${i}.ics`, data })),
      createCalendarObject: async () => ({}),
    });
  }
  const icsOf = (...vevents) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevents.flat(), 'END:VCALENDAR'].join('\r\n');
  const otherEvent = [
    'BEGIN:VEVENT', 'UID:other@test', 'SUMMARY:Anderes',
    'DTSTART:20260106T170000Z', 'DTEND:20260106T180000Z', 'END:VEVENT',
  ];

  it('beim Neuanlegen zaehlt eine hochgeladene, nie bearbeitete Zeile nicht als Altlast', () => withDb(async (d) => {
    // Die Waisen-Pruefung in addAccount nimmt denselben Filter: eine Zeile mit
    // user_modified = 0 kann keine eingebrannte Farbe tragen und darf das neue
    // Konto nicht in den Heilungslauf schicken.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    d.prepare('UPDATE calendar_events SET color = ?, color_modified = 1, user_modified = 0').run(COLOR_A);
    d.exec('DELETE FROM caldav_calendar_selection WHERE account_id = 1; DELETE FROM caldav_accounts WHERE id = 1;');

    const { accountId } = await addAccount('Wieder', 'https://dav.example/', 'u1', 'p', { createClient: accountClient([CAL_B]) });
    assert.strictEqual(healState(d, `caldav_legacy_color_heal_since_${accountId}`), 'never');
  }));

  // Ein von retireLegacyInstances() (google-calendar.js) abgeloestes
  // Google-Vorkommen: lokal, user_modified = 1, color_modified = 1, altes
  // created_at, bewusst gewaehlte Farbe - hier gleich der Farbe von B, einem
  // ANDEREN Kalender des Kontos als seinem Ziel A. Nur die Farbe des eigenen
  // Zielkalenders kann damals eingebrannt worden sein.
  function retiredGoogleOccurrence(d) {
    d.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT NOT NULL);
            INSERT INTO schema_migrations VALUES (166, '#891', '2026-08-27T08:00:00Z');`);
    return d.prepare(`
      INSERT INTO calendar_events (title, start_datetime, end_datetime, external_source, color, color_modified,
                                   user_modified, created_by, target_caldav_account_id, target_caldav_calendar_url, created_at)
      VALUES ('Abgeloest', '2026-01-08T17:00:00Z', '2026-01-08T18:00:00Z', 'local', ?, 1, 1, 1, 1, ?, '2026-08-01T10:00:00Z')
    `).run(COLOR_B, CAL_A).lastInsertRowid;
  }
  const backWithoutColor = (d, id) => {
    const uid = d.prepare('SELECT external_calendar_id FROM calendar_events WHERE id = ?').get(id).external_calendar_id;
    return icsOf(['BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:Abgeloest',
      'DTSTART:20260108T170000Z', 'DTEND:20260108T180000Z', 'END:VEVENT']);
  };

  it('ein hochgeladener Termin mit der Farbe eines ANDEREN Kalenders als seines Ziels heilt nie', () => withDb(async (d) => {
    const id = retiredGoogleOccurrence(d);
    await sync({ createClient: rawClient({ objects: { [CAL_A]: [icsOf(otherEvent)] } }) });
    assert.strictEqual(d.prepare('SELECT external_source FROM calendar_events WHERE id = ?').get(id).external_source, 'caldav',
      'Vorbedingung: hochgeladen');

    await sync({ createClient: rawClient({ objects: { [CAL_A]: [backWithoutColor(d, id), icsOf(otherEvent)] } }) });
    assert.match(healState(d), ISO, 'Vorbedingung: die Heilung laeuft');
    assert.strictEqual(d.prepare('SELECT color FROM calendar_events WHERE id = ?').get(id).color, COLOR_B);
  }));

  it('beim Neuanlegen zaehlt ein hochgeladener Termin mit fremder Kalenderfarbe nicht als Altlast', () => withDb(async (d) => {
    const id = retiredGoogleOccurrence(d);
    await sync({ createClient: rawClient({ objects: { [CAL_A]: [icsOf(otherEvent)] } }) });
    assert.strictEqual(d.prepare('SELECT user_modified FROM calendar_events WHERE id = ?').get(id).user_modified, 1);
    d.exec('DELETE FROM caldav_calendar_selection WHERE account_id = 1; DELETE FROM caldav_accounts WHERE id = 1;');
    d.prepare("DELETE FROM calendar_events WHERE external_calendar_id = 'other@test'").run();

    const { accountId } = await addAccount('Wieder', 'https://dav.example/', 'u1', 'p', { createClient: accountClient([CAL_B]) });
    assert.strictEqual(healState(d, `caldav_legacy_color_heal_since_${accountId}`), 'never');
  }));

  it('ein vor v2.49 hochgeladener Termin mit der Farbe seines Zielkalenders heilt', () => withDb(async (d) => {
    // Die haeufigste Gruppe aus #1270: in Yuvomi mit CalDAV-Ziel angelegt,
    // ohne COLOR hochgeladen (vor #897), der naechste Inbound brannte die
    // Farbe des Zielkalenders ein, eine spaetere Bearbeitung fror sie ein.
    const OWN_UID = 'oikos-7@oikos.local';
    const ics = icsOf(['BEGIN:VEVENT', `UID:${OWN_UID}`, 'SUMMARY:Elternabend',
      'DTSTART:20260109T170000Z', 'DTEND:20260109T180000Z', 'END:VEVENT']);
    await sync({ createClient: rawClient({ objects: { [CAL_A]: [ics] } }) });
    d.prepare(`UPDATE calendar_events SET color = ?, user_modified = 1, color_modified = 1,
                 target_caldav_account_id = 1, target_caldav_calendar_url = ?
               WHERE external_calendar_id = ?`).run(COLOR_A, CAL_A, OWN_UID);
    d.prepare('DELETE FROM sync_config').run();

    await sync({ createClient: rawClient({ objects: { [CAL_A]: [ics] } }) });
    assert.strictEqual(row(d, OWN_UID).color, null);
  }));

  it('ein hochgeladener Termin ohne Zielkalender ist kein Kandidat', () => withDb(async (d) => {
    const OWN_UID = 'oikos-8@oikos.local';
    const ics = icsOf(['BEGIN:VEVENT', `UID:${OWN_UID}`, 'SUMMARY:Ohne Ziel',
      'DTSTART:20260109T170000Z', 'DTEND:20260109T180000Z', 'END:VEVENT']);
    await sync({ createClient: rawClient({ objects: { [CAL_A]: [ics] } }) });
    d.prepare(`UPDATE calendar_events SET color = ?, user_modified = 1, color_modified = 1
               WHERE external_calendar_id = ?`).run(COLOR_A, OWN_UID);
    d.prepare('DELETE FROM sync_config').run();

    await sync({ createClient: rawClient({ objects: { [CAL_A]: [ics] } }) });
    assert.strictEqual(row(d, OWN_UID).color, COLOR_A);
  }));

  // Zurechnung verwaister Kalender: im Zweifel nicht (Thread zu :180).
  async function orphanCase(d, orphanUrl, extraSql = '') {
    d.exec(`INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav', '${orphanUrl}', 'Alt', '${COLOR_C}'); ${extraSql}`);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_C);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    return row(d).color;
  }

  it('ein per Query adressierter verwaister Kalender wird keinem Konto zugerechnet', () => withDb(async (d) => {
    // Der Pfad eines Query-adressierten Kalenders sagt nichts ueber seinen
    // Besitzer; hier liegt er sogar unter dem Home von Konto 1.
    assert.strictEqual(await orphanCase(d, `${HOME_1}dav.php?cal=fremd`), COLOR_C);
  }));

  it('ein verwaister Kalender direkt an der Wurzel wird keinem Konto zugerechnet', () => withDb(async (d) => {
    // Konto 1 fuehrt zusaetzlich einen Kalender an der Wurzel des Servers:
    // dieses "Home" teilen sich alle Konten dort.
    const ROOT_OWN = 'https://dav.example/r1/';
    assert.strictEqual(await orphanCase(d, 'https://dav.example/r3/',
      `INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
         VALUES (1, '${ROOT_OWN}', 'R1', '#111111', 0);`), COLOR_C);
  }));

  it('ein verwaister Kalender in einem Home, das auch ein anderes Konto fuehrt, wird keinem zugerechnet', () => withDb(async (d) => {
    assert.strictEqual(await orphanCase(d, `${HOME_1}alt/`,
      `INSERT INTO caldav_accounts (id, name, caldav_url, username, password) VALUES (2, 'Zweit', 'https://dav.example/', 'u2', 'p');
       INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
         VALUES (2, '${HOME_1}geteilt/', 'Geteilt', '#222222', 0);`), COLOR_C);
  }));

  it('Gegenprobe: derselbe verwaiste Kalender im eigenen, eindeutigen Home wird zugerechnet', () => withDb(async (d) => {
    assert.strictEqual(await orphanCase(d, `${HOME_1}alt/`), null);
  }));

  it('ein in diesem Lauf hochgeladener alter lokaler Termin ist kein Heilungskandidat', () => withDb(async (d) => {
    // Thread zu :932. Ein lokaler Termin von vor #891 mit Palettenfarbe gleich
    // der Kalenderfarbe wird jetzt nach A hochgeladen. Der Upload setzt
    // color_modified = 1, created_at bleibt alt. Liefert der Server die
    // COLOR-Zeile nicht zurueck, darf die Heilung die Farbe nicht nehmen:
    // eingebrannt wurde nur an Zeilen, die schon vor #899 bearbeitet waren
    // (user_modified = 1), ein nur hochgeladener Termin ist das nicht.
    d.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT NOT NULL);
            INSERT INTO schema_migrations VALUES (166, '#891', '2026-08-27T08:00:00Z');`);
    const localId = d.prepare(`
      INSERT INTO calendar_events (title, start_datetime, end_datetime, external_source, color, created_by,
                                   target_caldav_account_id, target_caldav_calendar_url, created_at)
      VALUES ('Lokal', '2026-01-07T17:00:00Z', '2026-01-07T18:00:00Z', 'local', ?, 1, 1, ?, '2026-08-01T10:00:00Z')
    `).run(COLOR_A, CAL_A).lastInsertRowid;
    await sync({ createClient: rawClient({ objects: { [CAL_A]: [icsOf(otherEvent)] } }) });
    const uploaded = d.prepare('SELECT external_source, external_calendar_id, color_modified FROM calendar_events WHERE id = ?').get(localId);
    assert.strictEqual(uploaded.external_source, 'caldav', 'Vorbedingung: hochgeladen');
    assert.strictEqual(uploaded.color_modified, 1);

    const back = icsOf(['BEGIN:VEVENT', `UID:${uploaded.external_calendar_id}`, 'SUMMARY:Lokal',
      'DTSTART:20260107T170000Z', 'DTEND:20260107T180000Z', 'END:VEVENT']);
    await sync({ createClient: rawClient({ objects: { [CAL_A]: [back, icsOf(otherEvent)] } }) });
    assert.match(healState(d), ISO, 'Vorbedingung: die Heilung laeuft');
    assert.strictEqual(d.prepare('SELECT color FROM calendar_events WHERE id = ?').get(localId).color, COLOR_A);
  }));

  it('eine COLOR-Zeile mit unlesbarem Wert gehoert trotzdem dem Termin', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    // #RRGGBBAA kennt resolveIcalColor nicht; die Zeile steht aber da.
    await sync({ createClient: clientWith({ inCal: CAL_A, color: '#4A90E2FF' }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  // Migration 166 (#891) beendete das Einbrennen. Die Fixture fuehrt dafuer
  // eine kleine schema_migrations.
  function fixAppliedAt(d, appliedAt) {
    d.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT NOT NULL);`);
    d.prepare('INSERT INTO schema_migrations (version, description, applied_at) VALUES (166, ?, ?)').run('#891', appliedAt);
  }

  it('eine Zeile, die NACH dem Fix aus #891 entstand, heilt nie', () => withDb(async (d) => {
    // Etwa ein Konto, das zwischen v2.49 und diesem Update angelegt wurde:
    // sein Import hat nie eine Kalenderfarbe eingebrannt. Eine Farbe gleich
    // der Kalenderfarbe ist dort eine gewaehlte.
    fixAppliedAt(d, '2026-08-27T08:00:00Z');
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    // Am selben Tag, eine halbe Stunde spaeter, im Leerzeichen-Format aelterer
    // Migrationen: ein reiner Textvergleich hielte ' ' < 'T' fuer aelter.
    d.prepare("UPDATE calendar_events SET created_at = '2026-08-27 08:30:00'").run();
    legacyState(d, COLOR_A);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('eine Zeile von VOR dem Fix heilt, auch im alten Datumsformat', () => withDb(async (d) => {
    // Gegenprobe zur Altersgrenze; das Leerzeichen-Format stammt aus aelteren
    // Migrationen (datetime('now')) und muss richtig verglichen werden.
    fixAppliedAt(d, '2026-08-27T08:00:00Z');
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    d.prepare("UPDATE calendar_events SET created_at = '2026-08-27 07:59:00'").run();
    legacyState(d, COLOR_A);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, null);
  }));

  // --- Frist statt Merker ---

  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const SNAPSHOT_KEY_1 = 'caldav_legacy_color_heal_snapshot_1';
  const rowId = (d, uid = UID) => d.prepare('SELECT id FROM calendar_events WHERE external_calendar_id = ?').get(uid).id;
  // Eine laufende Frist samt Schnappschuss, wie der erste Lauf sie anlegt.
  // `snapshot` als Objekt oder als roher Text (fuer den kaputten Fall).
  function startWindow(d, since, snapshot) {
    d.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(HEAL_KEY_1, since);
    if (snapshot !== undefined) {
      d.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)')
        .run(SNAPSHOT_KEY_1, typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot));
    }
  }

  it('die Heilung laeuft innerhalb der Frist von 30 Tagen ab dem ersten Lauf', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    startWindow(d, daysAgo(29), { [rowId(d)]: COLOR_A });

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, null);
  }));

  it('nach Ablauf der Frist heilt nichts mehr', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(HEAL_KEY_1, daysAgo(31));

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('traegt IRGENDEINE Kopie einer UID eine COLOR-Zeile, bleibt die Farbe, egal in welcher Reihenfolge', () => withDb(async (d) => {
    // Beim Umzug liefert der Server dieselbe UID kurz in zwei Kalendern. Die
    // Reihenfolge der Kalender darf nicht entscheiden, ob die Farbe bleibt.
    const withColor = icsOf(vevent({ color: 'tomato' }));
    const without = icsOf(vevent());
    await sync({ createClient: clientWith({ inCal: CAL_A }) });

    legacyState(d, COLOR_A);
    await sync({ createClient: rawClient({ objects: { [CAL_A]: [withColor], [CAL_B]: [without] } }) });
    assert.strictEqual(row(d).color, COLOR_A, 'COLOR im ersten Kalender');

    legacyState(d, COLOR_A);
    await sync({ createClient: rawClient({ objects: { [CAL_A]: [without], [CAL_B]: [withColor] } }) });
    assert.strictEqual(row(d).color, COLOR_A, 'COLOR im zweiten Kalender');
  }));

  it('die Farbe einer reinen Aufgabenliste zaehlt nicht als Kalenderfarbe', () => withDb(async (d) => {
    // Konten von vor dem Komponentenfilter (#617) tragen Aufgabenlisten noch in
    // der Auswahl. Eine VTODO-Liste hat nie eine Farbe in einen Termin gebrannt.
    const LIST = `${HOME_1}aufgaben/`;
    const COLOR_LIST = '#12A4B6';
    d.prepare(`INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
               VALUES (1, ?, 'Aufgaben', ?, 0)`).run(LIST, COLOR_LIST);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_LIST);

    await sync({ createClient: rawClient({
      calendars: [CAL_A, CAL_B, LIST],
      objects: { [CAL_A]: [icsOf(vevent())] },
      components: { [LIST]: ['VTODO'] },
    }) });
    assert.strictEqual(row(d).color, COLOR_LIST);
  }));

  it('eine Zeile aus genau der Sekunde der Migration 166 zaehlt als alt', () => withDb(async (d) => {
    fixAppliedAt(d, '2026-08-27T08:00:00Z');
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    d.prepare("UPDATE calendar_events SET created_at = '2026-08-27T08:00:00Z'").run();
    legacyState(d, COLOR_A);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, null);
  }));

  it('ein umgehaengtes Konto (neuer Benutzer) entscheidet neu und heilt uebernommene Altzeilen', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(HEAL_KEY_1, daysAgo(40));

    await updateAccount(1, { username: 'u9', createClient: accountClient([CAL_A, CAL_B]) });
    assert.strictEqual(healState(d), null, 'die alte, abgelaufene Frist ist verworfen');
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 1 WHERE calendar_url = ?').run(CAL_A);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, null);
  }));

  it('ein umgehaengtes Konto ohne Altzeilen heilt nie', () => withDb(async (d) => {
    d.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(HEAL_KEY_1, daysAgo(2));
    await updateAccount(1, { caldavUrl: 'https://dav2.example/', createClient: accountClient([CAL_A]) });
    assert.strictEqual(healState(d), 'never');
  }));

  it('ein reiner Passwortwechsel laesst die Frist stehen', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    const since = daysAgo(40);
    d.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(HEAL_KEY_1, since);

    await updateAccount(1, { password: 'neu', createClient: accountClient([CAL_A, CAL_B]) });
    assert.strictEqual(healState(d), since);
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 1 WHERE calendar_url = ?').run(CAL_A);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A, 'die Frist ist abgelaufen');
  }));

  // Waehrend Kalender B abgerufen wird, aendert jemand den Termin in Yuvomi.
  // `change` schreibt, was die Route schreiben wuerde.
  function clientChangingDuringB(d, change) {
    return async () => ({
      fetchCalendars: async () => [CAL_A, CAL_B].map((url) => ({ url, displayName: url })),
      fetchCalendarObjects: async ({ calendar }) => {
        if (calendar.url === CAL_A) return [{ url: `${CAL_A}series-1.ics`, data: icsOf(vevent()) }];
        change();
        return [];
      },
      createCalendarObject: async () => ({}),
    });
  }

  it('eine waehrend des Laufs gewaehlte Farbe ueberlebt die aufgeschobene Heilung', () => withDb(async (d) => {
    // Geheilt wird erst nach allen Kalendern, also nach den awaits der
    // uebrigen. Waehlt in der Zeit jemand eine Farbe (color, color_modified,
    // outbound_dirty), darf die Heilung sie nicht nehmen.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    const chosen = '#00AA00';
    await sync({ createClient: clientChangingDuringB(d, () => d.prepare(
      'UPDATE calendar_events SET color = ?, color_modified = 1, outbound_dirty = 1 WHERE external_calendar_id = ?'
    ).run(chosen, UID)) });
    assert.strictEqual(row(d).color, chosen);
  }));

  it('eine waehrend des Laufs gespeicherte Bearbeitung ohne Farbwechsel stoppt die Heilung', () => withDb(async (d) => {
    // Die Bearbeitung geht mit ihrer Farbe als COLOR-Zeile hinaus; ab dann
    // gehoert die Farbe dem Termin.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    await sync({ createClient: clientChangingDuringB(d, () => d.prepare(
      'UPDATE calendar_events SET outbound_dirty = 1 WHERE external_calendar_id = ?'
    ).run(UID)) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('eine waehrend des Laufs geaenderte Farbe wird nicht geheilt, auch ohne Ausgangsmarke', () => withDb(async (d) => {
    // Gegenstueck zur Probe oben: die Farbe allein muss reichen.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    await sync({ createClient: clientChangingDuringB(d, () => d.prepare(
      'UPDATE calendar_events SET color = ? WHERE external_calendar_id = ?'
    ).run(COLOR_B, UID)) });
    assert.strictEqual(row(d).color, COLOR_B);
  }));

  it('mit dem Eintrag never heilt ein Konto nie, auch einen echten Kandidaten', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.prepare("INSERT INTO sync_config (key, value) VALUES (?, 'never')").run(HEAL_KEY_1);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('ein Eintrag, der kein Datum ist, schaltet die Heilung aus', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.prepare("INSERT INTO sync_config (key, value) VALUES (?, 'xyz')").run(HEAL_KEY_1);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('ein Fristbeginn in der Zukunft verlaengert die Heilung nicht', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(HEAL_KEY_1, daysAgo(-2));
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('ein Lauf ohne aktivierte Kalender beginnt die Frist nicht', () => withDb(async (d) => {
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 0').run();
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(healState(d), null);
  }));

  it('dieselbe Adresse mit Schraegstrich oder grossem Host startet die Frist nicht neu', () => withDb(async (d) => {
    const since = daysAgo(40);
    d.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(HEAL_KEY_1, since);
    await updateAccount(1, { caldavUrl: 'https://dav.example', createClient: accountClient([CAL_A]) });
    assert.strictEqual(healState(d), since, 'ohne Schraegstrich am Ende');
    await updateAccount(1, { caldavUrl: 'https://DAV.Example:443/', createClient: accountClient([CAL_A]) });
    assert.strictEqual(healState(d), since, 'grosser Host, Standardport');
  }));

  it('eine abgeschaltete Auswahl, die der Server nicht mehr listet, liefert keine Farbe', () => withDb(async (d) => {
    // Etwa eine frueher automatisch abgeschaltete Aufgabenliste, die es auf dem
    // Server nicht mehr gibt: was sie war, weiss danach niemand. Lieber nicht
    // heilen als eine gewollte Farbe verlieren.
    const LIST = `${HOME_1}aufgaben-alt/`;
    const COLOR_LIST = '#6B4E9A';
    d.prepare(`INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
               VALUES (1, ?, 'Aufgaben alt', ?, 0)`).run(LIST, COLOR_LIST);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_LIST);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_LIST);
  }));

  it('beim Wiederanlegen zaehlt die Zielfarbe aus der neuen Auswahl', () => withDb(async (d) => {
    // Eine hochgeladene Altzeile zaehlt nur mit der Farbe ihres Zielkalenders.
    // Steht die nirgends mehr ausser in der Auswahl des neuen Kontos (hier hat
    // external_calendars keine Farbe), muss die Entscheidung sie sehen.
    const OWN_UID = 'oikos-9@oikos.local';
    const ics = icsOf(['BEGIN:VEVENT', `UID:${OWN_UID}`, 'SUMMARY:Elternabend',
      'DTSTART:20260109T170000Z', 'DTEND:20260109T180000Z', 'END:VEVENT']);
    await sync({ createClient: rawClient({ objects: { [CAL_A]: [ics] } }) });
    d.prepare(`UPDATE calendar_events SET color = ?, user_modified = 1, color_modified = 1,
                 target_caldav_account_id = 1, target_caldav_calendar_url = ?
               WHERE external_calendar_id = ?`).run(COLOR_A, CAL_A, OWN_UID);
    d.prepare('UPDATE external_calendars SET color = NULL').run();
    d.exec('DELETE FROM caldav_calendar_selection WHERE account_id = 1; DELETE FROM caldav_accounts WHERE id = 1; DELETE FROM sync_config;');

    const { accountId } = await addAccount('Wieder', 'https://dav.example/', 'u1', 'p', { createClient: accountClient([CAL_A, CAL_B]) });
    assert.strictEqual(healState(d, `caldav_legacy_color_heal_since_${accountId}`), null,
      'die Zeile ist eine Altlast, die Heilung steht offen');
  }));

  it('ein anstehender reiner Umzug schuetzt die Farbe vor der Heilung', () => withDb(async (d) => {
    // Ein reiner Umzug setzt nur outbound_move_to, kein outbound_dirty. Bis er
    // ausgefuehrt ist, faesst die Heilung den Termin nicht an, auch wenn der
    // Server ihn ohne COLOR liefert.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.prepare('UPDATE calendar_events SET outbound_move_to = ? WHERE external_calendar_id = ?').run(CAL_B, UID);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('ein waehrend des Laufs angestossener Umzug schuetzt die Farbe ebenso', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    await sync({ createClient: clientChangingDuringB(d, () => d.prepare(
      'UPDATE calendar_events SET outbound_move_to = ? WHERE external_calendar_id = ?'
    ).run(CAL_B, UID)) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('der erste Lauf legt Frist und Schnappschuss gemeinsam an', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 0 WHERE calendar_url = ?').run(CAL_A);
    d.prepare('UPDATE caldav_calendar_selection SET enabled = 1 WHERE calendar_url = ?').run(CAL_B);
    // Der Lauf sieht die Zeile nicht (A ist abgewaehlt): der Schnappschuss
    // haelt sie trotzdem fest, mit ihrer Farbe von jetzt.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.match(healState(d), ISO);
    assert.deepStrictEqual(JSON.parse(healState(d, SNAPSHOT_KEY_1)), { [rowId(d)]: COLOR_A.toLowerCase() });
  }));

  it('eine nach der Heilung neu gewaehlte Kalenderfarbe bleibt, auch wenn der Server COLOR verwirft', () => withDb(async (d) => {
    // Codex 4079517707: geheilt, dann in Yuvomi auf eine Kalenderfarbe des
    // Kontos umgefaerbt; der Server nimmt den Push an und verwirft COLOR.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, null, 'Vorbedingung: geheilt');
    d.prepare(`UPDATE calendar_events SET color = ?, color_modified = 1, user_modified = 1, outbound_dirty = 1
               WHERE external_calendar_id = ?`).run(COLOR_A, UID);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    d.prepare('UPDATE calendar_events SET outbound_dirty = 0 WHERE external_calendar_id = ?').run(UID);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('eine noch nicht geheilte Zeile, in der Frist auf eine andere Kalenderfarbe umgefaerbt, bleibt', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    // Die Frist laeuft, der Schnappschuss kennt die Zeile mit A.
    startWindow(d, daysAgo(3), { [rowId(d)]: COLOR_A });
    // Umgefaerbt auf B, gepusht, der Server hat COLOR verworfen.
    d.prepare('UPDATE calendar_events SET color = ?, color_modified = 1, user_modified = 1 WHERE external_calendar_id = ?')
      .run(COLOR_B, UID);

    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_B);
  }));

  it('ohne Schnappschuss bei laufender Frist heilt nichts', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    startWindow(d, daysAgo(3));
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('ein kaputter Schnappschuss heilt nichts', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    startWindow(d, daysAgo(3), '{kaputt');
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A, 'unlesbares JSON');

    d.prepare('UPDATE sync_config SET value = ? WHERE key = ?').run(`[${rowId(d)}]`, SNAPSHOT_KEY_1);
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.strictEqual(row(d).color, COLOR_A, 'kein Objekt');
  }));

  it('updateAccount mit neuem Benutzer raeumt den Schnappschuss mit', () => withDb(async (d) => {
    startWindow(d, daysAgo(40), { 999: COLOR_A });
    await updateAccount(1, { username: 'u9', createClient: accountClient([CAL_A]) });
    assert.strictEqual(healState(d, SNAPSHOT_KEY_1), null);
  }));

  it('eine unlesbare Vormerkliste lokaler Farbwahlen fuellt keinen Schnappschuss', () => withDb(async (d) => {
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);
    d.prepare("INSERT INTO sync_config (key, value) VALUES ('caldav_legacy_color_heal_chosen', '{kaputt')").run();
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    assert.deepStrictEqual(JSON.parse(healState(d, SNAPSHOT_KEY_1)), {});
    assert.strictEqual(row(d).color, COLOR_A);
  }));

  it('eine gewaehlte Farbe, die keine Kalenderfarbe ist, bleibt', () => withDb(async (d) => {
    // Gegenprobe: ohne sie waere der Test oben auch gruen, wenn der Inbound
    // jede lokal gefuehrte Farbe verwuerfe.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, '#3CA368');

    await sync({ createClient: clientWith({ inCal: CAL_B }) });
    const after = row(d);
    assert.strictEqual(after.color, '#3CA368');
    assert.strictEqual(after.color_modified, 1);
  }));

  it('traegt der Termin selbst eine COLOR-Zeile, bleibt die lokale Farbe', () => withDb(async (d) => {
    // Mit COLOR-Zeile spricht der Server ueber DIESEN Termin; die lokal
    // gefuehrte Farbe gewinnt dann wie bisher (#899), die Heilung greift nicht.
    await sync({ createClient: clientWith({ inCal: CAL_A }) });
    legacyState(d, COLOR_A);

    await sync({ createClient: clientWith({ inCal: CAL_B, color: 'tomato' }) });
    assert.strictEqual(row(d).color, COLOR_A);
  }));
});

// --------------------------------------------------------
// Bestandskonten: Aufgabenlisten fliegen aus der Kalenderauswahl (#617)
// --------------------------------------------------------

describe('CalDAV: eine Aufgabenliste bleibt kein Terminziel (#617)', () => {
  const EVENT_URL = 'https://dav.example/termine/';
  const TODO_URL  = 'https://dav.example/aufgaben/';

  function buildDb() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT);
      INSERT INTO users (display_name) VALUES ('Owner');

      -- Die Frist der Farb-Heilung (#1270) liegt hier.
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, description TEXT,
        start_datetime TEXT, end_datetime TEXT, all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT, color TEXT, recurrence_rule TEXT, tzid TEXT,
        external_calendar_id TEXT, external_source TEXT,
        calendar_ref_id INTEGER, created_by INTEGER,
        user_modified INTEGER NOT NULL DEFAULT 0, assigned_to INTEGER,
        -- Der eigene Zustand der Farbe (#899, Migration v167): das Farb-Gatter
        -- des Inbound haengt daran, nicht mehr an user_modified.
        color_modified INTEGER NOT NULL DEFAULT 0,
        target_caldav_account_id INTEGER, target_caldav_calendar_url TEXT,
        outbound_dirty INTEGER NOT NULL DEFAULT 0,
        outbound_attempts INTEGER NOT NULL DEFAULT 0,
        outbound_move_to TEXT,
        external_object_url TEXT
      );
      CREATE TABLE calendar_pending_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        calendar_external_id TEXT NOT NULL,
        event_external_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        object_url TEXT,
        UNIQUE(source, calendar_external_id, event_external_id)
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
      -- Beide Sammlungen aktiviert, wie ein vor dem Filter angelegtes Konto sie traegt.
      INSERT INTO caldav_calendar_selection
        (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (1, '${EVENT_URL}', 'Termine', '#4A90E2', 1),
               (1, '${TODO_URL}',  'Aufgaben', '#4A90E2', 1);
    `);
    return d;
  }

  const client = async () => ({
    fetchCalendars: async () => [
      { url: EVENT_URL, displayName: 'Termine',  components: ['VEVENT'] },
      { url: TODO_URL,  displayName: 'Aufgaben', components: ['VTODO'] },
    ],
    fetchCalendarObjects: async ({ calendar }) => (calendar.url === EVENT_URL ? [{
      data: [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
        'UID:evt-1@test', 'SUMMARY:Termin',
        'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z',
        'END:VEVENT', 'END:VCALENDAR',
      ].join('\r\n'),
    }] : []),
    createCalendarObject: async () => ({}),
  });

  function enabledUrls(d) {
    return d.prepare('SELECT calendar_url FROM caldav_calendar_selection WHERE enabled = 1 ORDER BY calendar_url')
      .all().map(r => r.calendar_url);
  }

  it('nimmt eine Sammlung ohne VEVENT-Unterstuetzung aus der Auswahl', async () => {
    // Der Filter beim Anlegen erreicht Bestandskonten nicht mehr: deren Zeilen
    // stehen schon in der Tabelle, und bis jemand von Hand aktualisiert bliebe
    // die Aufgabenliste ein Ziel fuer Termine.
    const d = buildDb();
    _setTestDatabase(d);
    try {
      await sync({ createClient: client });
      assert.deepStrictEqual(enabledUrls(d), [EVENT_URL]);
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('laesst die dort bereits gespiegelten Termine liegen', async () => {
    // Abschalten heisst nicht wegwerfen: was Yuvomi frueher in die Aufgabenliste
    // geschrieben hat, liegt weiter im Kalender des Nutzers.
    const d = buildDb();
    _setTestDatabase(d);
    try {
      d.prepare(`
        INSERT INTO calendar_events (title, external_calendar_id, external_source, created_by)
        VALUES ('Alter Termin aus der Aufgabenliste', ?, 'caldav', 1)
      `).run(TODO_URL);

      await sync({ createClient: client });

      const row = d.prepare('SELECT title FROM calendar_events WHERE external_calendar_id = ?').get(TODO_URL);
      assert.ok(row, 'der Prune darf eine abgeschaltete Sammlung nicht leerraeumen');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('laesst eine Sammlung in Ruhe, die keine Komponenten meldet', async () => {
    // RFC 4791 5.2.3: ohne Angabe gilt alles als unterstuetzt. Ein strengerer
    // Test wuerde funktionierende Setups abschalten.
    const d = buildDb();
    _setTestDatabase(d);
    try {
      const silent = async () => ({
        fetchCalendars: async () => [
          { url: EVENT_URL, displayName: 'Termine' },
          { url: TODO_URL,  displayName: 'Aufgaben' },
        ],
        fetchCalendarObjects: async () => [],
        createCalendarObject: async () => ({}),
      });

      await sync({ createClient: silent });
      assert.deepStrictEqual(enabledUrls(d), [TODO_URL, EVENT_URL].sort());
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });
});

// --------------------------------------------------------
// #732: „Kalender aktualisieren" holt die Liste, es setzt die Auswahl nicht
// zurück. Vorher lief hier ein DELETE mit anschließendem INSERT auf enabled=1,
// und jeder bewusst abgewählte Kalender kam ungefragt in den Sync zurück -
// mitsamt seinen Terminen beim nächsten Lauf.
// --------------------------------------------------------
describe('CalDAV: die Kalenderauswahl überlebt das Aktualisieren (#732)', () => {
  const KEEP_URL = 'https://dav.example/privat/';
  const DROP_URL = 'https://dav.example/arbeit/';
  const NEW_URL  = 'https://dav.example/neu/';

  function buildDb() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      -- Die Frist der Farb-Heilung (#1270) liegt hier.
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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

      INSERT INTO caldav_accounts (name, caldav_url, username, password)
        VALUES ('Mailbox', 'https://dav.example/', 'u', 'p');
      INSERT INTO caldav_calendar_selection
        (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (1, '${KEEP_URL}', 'Privat', '#4A90E2', 1),
               (1, '${DROP_URL}', 'Arbeit', '#4A90E2', 0);
    `);
    return d;
  }

  // Der Server meldet einen Kalender mehr als beim letzten Mal - so unterscheidet
  // der Test den Umgang mit NEUEN von dem mit BEKANNTEN Kalendern. Seit dem
  // Opt-in (#732) kommen beide Gruppen abgewaehlt heraus, wenn niemand sie
  // angehakt hat; der Test haelt fest, dass ein bekannter Stand ueberlebt.
  const client = async () => ({
    fetchCalendars: async () => [
      { url: KEEP_URL, displayName: 'Privat', components: ['VEVENT'] },
      { url: DROP_URL, displayName: 'Arbeit', components: ['VEVENT'] },
      { url: NEW_URL,  displayName: 'Neu',    components: ['VEVENT'] },
    ],
  });

  const selection = (d) => Object.fromEntries(
    d.prepare('SELECT calendar_url, enabled FROM caldav_calendar_selection ORDER BY calendar_url')
      .all().map((r) => [r.calendar_url, r.enabled])
  );

  it('lässt einen abgewählten Kalender abgewählt und aktiviert nur neue', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      const result = await getCalendars(1, { refresh: true, createClient: client });

      assert.deepStrictEqual(selection(d), {
        [KEEP_URL]: 1,
        [DROP_URL]: 0,   // der Kern des Fehlers: stand nach dem Refresh auf 1
        [NEW_URL]:  0,   // unbekannt = abgewaehlt, dieselbe Opt-in-Regel wie beim Anlegen (#732)
      });

      // Auch die Rückgabe an die Oberfläche muss den echten Stand tragen - sonst
      // steht dort ein Haken, den die Datenbank nicht kennt.
      assert.deepStrictEqual(
        Object.fromEntries(result.map((c) => [c.calendarUrl, c.enabled])),
        { [KEEP_URL]: true, [DROP_URL]: false, [NEW_URL]: false }
      );
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('hält die Abwahl auch beim Wechsel der Zugangsdaten (zweiter Fundort)', async () => {
    // Derselbe Rücksetzer stand ein zweites Mal in updateAccount: neue
    // Zugangsdaten heißen neue Kalenderliste, nicht neue Auswahl.
    const d = buildDb();
    _setTestDatabase(d);
    try {
      await updateAccount(1, { password: 'neues-passwort', createClient: client });
      assert.equal(selection(d)[DROP_URL], 0, 'ein Passwortwechsel darf keinen Kalender einschalten');
      assert.equal(selection(d)[NEW_URL], 0, 'auch ein neu gemeldeter Kalender kommt abgewaehlt');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });
});

// --------------------------------------------------------
// #732: Abwählen und Kontolöschung räumen auf Wunsch auf. Der Melder nutzt
// CalDAV als Quelle der Wahrheit: ein abgewählter Kalender soll auch seine
// Termine mitnehmen können, statt sie von Hand einzeln löschen zu müssen.
// --------------------------------------------------------
describe('CalDAV: das Aufräumen beim Abwählen ist eine Wahl (#732)', () => {
  const CAL_A = 'https://dav.example/privat/';
  const CAL_B = 'https://dav.example/arbeit/';

  function buildDb() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT);
      INSERT INTO users (display_name) VALUES ('Owner');

      -- Die Frist der Farb-Heilung (#1270) liegt hier.
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE caldav_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, caldav_url TEXT, username TEXT, password TEXT, last_sync TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, start_datetime TEXT,
        external_calendar_id TEXT, external_source TEXT NOT NULL DEFAULT 'local',
        calendar_ref_id INTEGER, created_by INTEGER,
        user_modified INTEGER NOT NULL DEFAULT 0,
        target_caldav_calendar_url TEXT
      );
      CREATE TABLE caldav_todo_pending_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER
      );
      CREATE TABLE calendar_pending_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, calendar_external_id TEXT NOT NULL,
        event_external_id TEXT NOT NULL,
        UNIQUE(source, calendar_external_id, event_external_id)
      );
      -- detachAccountRows() entkoppelt die gespiegelten Aufgaben/Einkaufsposten
      -- und braucht dafuer deren volle Outbound-Spalten.
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_source TEXT NOT NULL DEFAULT 'local', external_uid TEXT,
        external_account_id INTEGER, external_object_url TEXT,
        outbound_dirty INTEGER NOT NULL DEFAULT 0, outbound_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE shopping_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_source TEXT NOT NULL DEFAULT 'local', external_uid TEXT,
        external_account_id INTEGER, external_object_url TEXT,
        outbound_dirty INTEGER NOT NULL DEFAULT 0, outbound_attempts INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO caldav_accounts (name, caldav_url, username, password)
        VALUES ('Mailbox', 'https://dav.example/', 'u', 'p');
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (1, '${CAL_A}', 'Privat', '#4A90E2', 1),
               (1, '${CAL_B}', 'Arbeit', '#4A90E2', 1);
      INSERT INTO external_calendars (source, external_id, name)
        VALUES ('caldav', '${CAL_A}', 'Privat'), ('caldav', '${CAL_B}', 'Arbeit');

      -- Zwei gespiegelte Termine im abzuwaehlenden Kalender, einer davon lokal
      -- bearbeitet; dazu ein Termin im NACHBARkalender und ein rein lokaler,
      -- der diesen Kalender nur als Hochladeziel traegt.
      INSERT INTO calendar_events (title, start_datetime, external_calendar_id, external_source, calendar_ref_id, created_by, user_modified)
        VALUES ('Gespiegelt',  '2026-08-14T10:00', 'uid-1', 'caldav', 1, 1, 0),
               ('Bearbeitet',  '2026-08-15T10:00', 'uid-2', 'caldav', 1, 1, 1),
               ('Nachbar',     '2026-08-16T10:00', 'uid-3', 'caldav', 2, 1, 0);
      INSERT INTO calendar_events (title, start_datetime, external_source, created_by, target_caldav_calendar_url)
        VALUES ('Eigener Termin', '2026-08-17T10:00', 'local', 1, '${CAL_A}');
      -- Der Fall, der den source-Filter ueberhaupt erst pruefbar macht: ein
      -- NICHT gespiegelter Termin, der trotzdem an diesem Kalender haengt. Ohne
      -- ihn liefe die Sonde ueber calendar_ref_id allein und waere blind dafuer,
      -- ob der Filter etwas tut (gegengeprueft: er blieb gruen, als ich ihn
      -- entfernte).
      INSERT INTO calendar_events (title, start_datetime, external_source, calendar_ref_id, created_by)
        VALUES ('Lokal am Kalender', '2026-08-18T10:00', 'local', 1, 1);
    `);
    // `node:sqlite` kennt kein `.transaction()`; die App laeuft auf
    // better-sqlite3, das eine mitbringt. Der Shim bildet nur deren Semantik ab
    // (Rueckgabe einer aufrufbaren Funktion, Rollback bei Fehler) - ohne ihn
    // testet diese Suite den Transaktionspfad von deleteAccount gar nicht.
    d.transaction = (fn) => (...args) => {
      d.exec('BEGIN');
      try {
        const out = fn(...args);
        d.exec('COMMIT');
        return out;
      } catch (err) {
        d.exec('ROLLBACK');
        throw err;
      }
    };
    return d;
  }

  const titles = (d) => d.prepare('SELECT title FROM calendar_events ORDER BY title').all().map((r) => r.title);

  it('lässt die Termine stehen, solange niemand das Aufräumen wählt', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      updateCalendarSelection(1, CAL_A, false);
      assert.deepEqual(titles(d), ['Bearbeitet', 'Eigener Termin', 'Gespiegelt', 'Lokal am Kalender', 'Nachbar'],
        'ohne deleteEvents bleibt alles liegen - das ist die Vorgabe');
      assert.equal(d.prepare('SELECT enabled FROM caldav_calendar_selection WHERE calendar_url = ?').get(CAL_A).enabled, 0);
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('räumt auf Wunsch genau diesen Kalender auf, inklusive bearbeiteter Termine', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      const result = updateCalendarSelection(1, CAL_A, false, { deleteEvents: true });
      assert.equal(result.removed, 2, 'beide gespiegelten Termine dieses Kalenders');
      assert.deepEqual(titles(d), ['Eigener Termin', 'Lokal am Kalender', 'Nachbar'],
        'Nachbarkalender und beide lokalen Termine bleiben unberührt - auch der, '
        + 'der an genau diesem Kalender haengt');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('meldet den entfernten Kalender NICHT nach aussen', async () => {
    // Der teuerste denkbare Fehler an dieser Stelle: Wer seine lokale Kopie
    // wegräumt, würde damit den Kalender bei allen anderen Clients der Familie
    // leeren. Lokales Aufräumen darf keinen Tombstone hinterlassen.
    const d = buildDb();
    _setTestDatabase(d);
    try {
      updateCalendarSelection(1, CAL_A, false, { deleteEvents: true });
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM calendar_pending_deletions').get().n, 0,
        'kein Tombstone - der Fremdkalender bleibt unberührt');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('räumt beim Löschen des Kontos alle seine Kalender auf, wenn gewählt', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      const result = deleteAccount(1, { deleteEvents: true });
      assert.equal(result.removed, 3, 'beide Kalender des Kontos');
      assert.deepEqual(titles(d), ['Eigener Termin', 'Lokal am Kalender']);
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM calendar_pending_deletions').get().n, 0);
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('lässt beim Löschen des Kontos ohne die Wahl alles stehen (Bestandsverhalten)', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      // Frist der Farb-Heilung (#1270) von Konto 1 und einem Nachbarn.
      d.exec(`INSERT INTO sync_config (key, value) VALUES
        ('caldav_legacy_color_heal_since_1', '2026-09-23T10:00:00.000Z'), ('caldav_legacy_color_heal_since_2', 'never'),
        ('caldav_legacy_color_heal_snapshot_1', '{}')`);
      const result = deleteAccount(1);
      assert.equal(result.removed, 0);
      assert.deepEqual(
        d.prepare("SELECT key FROM sync_config WHERE key LIKE 'caldav_legacy_color_heal_%' ORDER BY key").all().map((r) => r.key),
        ['caldav_legacy_color_heal_since_2'],
        'mit dem Konto gehen Frist und Schnappschuss, die des Nachbarn bleibt'
      );
      assert.equal(titles(d).length, 5, 'die Termine bleiben sichtbar, wie bisher');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('zählt für die Rückfrage, was tatsächlich verschwinden würde', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      // Die Zahl im Dialog muss der späteren Löschung entsprechen, sonst nennt
      // die Frage eine andere Menge als die Antwort entfernt.
      assert.equal(countAccountEvents(1), 3, 'gespiegelte Termine beider Kalender, ohne den lokalen');
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });
});

// --------------------------------------------------------
// #732: Ein neues Konto bringt seine Kalender ABGEWÄHLT mit. Vorher lief nach
// dem Verbinden jeder gefundene Kalender sofort in den Haushalt - inklusive
// Arbeits-, Geburtstags- und Feiertagskalendern, die niemand bestellt hat.
// --------------------------------------------------------
describe('CalDAV: neue Kalender sind opt-in (#732)', () => {
  function buildDb() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      -- Die Frist der Farb-Heilung (#1270) liegt hier.
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE caldav_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, caldav_url TEXT, username TEXT, password TEXT, last_sync TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        -- die Farb-Heilung (#1270) grenzt nach dem Alter der Zeile ab
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
        calendar_ref_id INTEGER, external_source TEXT NOT NULL DEFAULT 'local',
        -- addAccount sucht hier nach Altzeilen der Farb-Heilung (#1270).
        color TEXT, color_modified INTEGER NOT NULL DEFAULT 0,
        user_modified INTEGER NOT NULL DEFAULT 0, external_calendar_id TEXT,
        target_caldav_calendar_url TEXT
      );
    `);
    // addAccount schreibt in einer Transaktion (#1270); `node:sqlite` hat keine.
    d.transaction = (fn) => (...args) => {
      d.exec('BEGIN');
      try { const out = fn(...args); d.exec('COMMIT'); return out; }
      catch (err) { d.exec('ROLLBACK'); throw err; }
    };
    return d;
  }

  const client = async () => ({
    fetchCalendars: async () => [
      { url: 'https://dav.example/privat/',    displayName: 'Privat',     components: ['VEVENT'] },
      { url: 'https://dav.example/arbeit/',    displayName: 'Arbeit',     components: ['VEVENT'] },
      { url: 'https://dav.example/feiertage/', displayName: 'Feiertage',  components: ['VEVENT'] },
    ],
  });

  it('legt ein neues Konto mit lauter abgewählten Kalendern an', async () => {
    const d = buildDb();
    _setTestDatabase(d);
    try {
      const { calendars } = await addAccount('Mailbox', 'https://dav.example/', 'u', 'p', { createClient: client });
      assert.equal(calendars.length, 3);
      assert.deepEqual(calendars.map((c) => c.enabled), [false, false, false],
        'nichts läuft, bis jemand es anhakt');
      assert.equal(
        d.prepare('SELECT COUNT(*) AS n FROM caldav_calendar_selection WHERE enabled = 1').get().n, 0,
        'auch in der Datenbank, nicht nur in der Rückgabe'
      );
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });

  it('lässt einen angehakten Kalender beim Auffrischen angehakt', async () => {
    // Die Gegenrichtung: Opt-in gilt für NEUE Kalender, es setzt keine
    // getroffene Wahl zurück (das war der Fehler aus derselben Ausgabe).
    const d = buildDb();
    _setTestDatabase(d);
    try {
      await addAccount('Mailbox', 'https://dav.example/', 'u', 'p', { createClient: client });
      d.prepare("UPDATE caldav_calendar_selection SET enabled = 1 WHERE calendar_url = ?")
        .run('https://dav.example/privat/');

      const refreshed = await getCalendars(1, { refresh: true, createClient: client });
      const state = Object.fromEntries(refreshed.map((c) => [c.calendarName, c.enabled]));
      assert.deepEqual(state, { Privat: true, Arbeit: false, Feiertage: false });
    } finally {
      _resetTestDatabase();
      d.close();
    }
  });
});
