/**
 * Test: UNTIL behaelt seine Uhrzeit (#1269)
 *
 * Zweck: Ein "dieser und alle folgenden"-Schnitt in einem fremden Kalender
 *        beendet die alte Serie EINE SEKUNDE VOR dem Start am Schnitttag, nicht
 *        am Vortag - Open-Xchange (mailbox.org) schreibt
 *        `UNTIL=20260918T145959Z` bei einem Start um 17:00 Europe/Berlin. Wer
 *        davon nur den Datumsteil liest, laesst den Schnitttag eingeschlossen;
 *        weil die neue Serie an ihm beginnt, steht der Termin dort zweimal.
 *
 * Laufweg: echter sync()-Pfad (caldav-sync.js mit eingesetztem Client) ->
 *          DB-Zeilen -> loadEventExceptions + expandRecurringEvents, also
 *          dieselbe Kette, die die Kalenderansicht liest.
 *
 * Die beiden VEVENT-Bloecke des ersten Falls sind die aus dem Ticket, Zeile fuer
 * Zeile - samt VTIMEZONE, gefalteter RELATED-TO-Zeile und EXDATE.
 *
 * Ausfuehren:
 *   TZ=UTC            node --experimental-sqlite --test test/test-caldav-until-time.js
 *   TZ=America/Denver node --experimental-sqlite --test test/test-caldav-until-time.js
 *
 * BEIDE ZONEN, UND DAS IST DER PUNKT: ein Lauf in UTC allein versteckt jeden
 * Fehler, der die Serverzone mit UTC verwechselt. Die zweite Zone liegt
 * westlich davon, wo der Kalendertag der Serverzone hinter dem UTC-Tag
 * zurueckbleibt. Gepruefte Zeitpunkte sind deshalb ueberall dieselben.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// Nach dem Setzen von DB_PATH: server/db.js verbindet BEIM IMPORT.
const { sync } = await import('../server/services/caldav-sync.js');
const { _setTestDatabase, _resetTestDatabase } = await import('../server/db.js');
const { expandRecurringEvents, loadEventExceptions } =
  await import('../server/services/calendar-events.js');

const CALENDAR_URL = 'https://dav.example/cal-1/';

// Dasselbe schlanke Schema wie in test-caldav-sync.js: genau die Tabellen, die
// der Sync anfasst.
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
    CREATE TABLE event_assignments (event_id INTEGER, user_id INTEGER, UNIQUE(event_id, user_id));
    CREATE TABLE calendar_event_exceptions (
      event_id INTEGER NOT NULL, exception_date TEXT NOT NULL,
      PRIMARY KEY (event_id, exception_date)
    );
    INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES ('OX', 'https://dav.example/', 'u', 'p');
    INSERT INTO caldav_calendar_selection
      (account_id, calendar_url, calendar_name, calendar_color, enabled)
      VALUES (1, '${CALENDAR_URL}', 'Cal 1', '#4A90E2', 1);
  `);
  return d;
}

const clientWith = (objects) => async () => ({
  fetchCalendars:       async () => [{ url: CALENDAR_URL, displayName: 'Cal 1' }],
  fetchCalendarObjects: async () => objects.map((data) => ({ data })),
  createCalendarObject: async () => ({}),
});

/**
 * Synct die Objekte und liest zurueck, was der Kalender im Fenster zeigt.
 * @returns {string[]} Startwerte der Instanzen (Instant mit Z, oder Datum bei
 *          Ganztagsterminen), aufsteigend sortiert.
 */
async function syncAndExpand(objects, from, to) {
  const d = buildDb();
  _setTestDatabase(d);
  try {
    await sync({ createClient: clientWith(objects) });
    const rows = d.prepare('SELECT * FROM calendar_events ORDER BY id').all();
    const exceptions = loadEventExceptions(
      d, rows.filter((row) => row.recurrence_rule).map((row) => row.id)
    );
    return expandRecurringEvents(rows, from, to, exceptions)
      .map((instance) => String(instance.start_datetime))
      .sort();
  } finally {
    _resetTestDatabase();
    d.close();
  }
}

/** Die Instanzen, deren Startwert auf `prefix` beginnt (Tag oder Instant). */
const am = (starts, prefix) => starts.filter((value) => value.startsWith(prefix));

const VCAL = (...lines) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Open-Xchange//8.52.252//EN',
  'METHOD:PUBLISH', ...lines, 'END:VCALENDAR',
].join('\r\n');

const VTIMEZONE = (tzid, ...body) => [
  'BEGIN:VTIMEZONE', `TZID:${tzid}`, `X-LIC-LOCATION:${tzid}`, ...body, 'END:VTIMEZONE',
];

// Europe/Berlin, wie mailbox.org es mitliefert.
const TZ_BERLIN = VTIMEZONE(
  'Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZNAME:CEST', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZNAME:CET', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
);

const TZ_NEW_YORK = VTIMEZONE(
  'America/New_York',
  'BEGIN:DAYLIGHT', 'TZNAME:EDT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400',
  'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZNAME:EST', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500',
  'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
);

// --------------------------------------------------------------------------
// Fall 1: die Bloecke aus dem Ticket, unveraendert.
// 17:00 Europe/Berlin = 15:00Z, also endet die alte Serie um 14:59:59Z am
// Schnitttag selbst - eine Sekunde vor ihrem eigenen Start an diesem Tag.
// --------------------------------------------------------------------------
const OX_ALT = VCAL(
  ...TZ_BERLIN,
  'BEGIN:VEVENT',
  'DTSTAMP:20260916T142652Z',
  'CLASS:PUBLIC',
  'CREATED:20230308T103320Z',
  'DTEND;TZID=Europe/Berlin:20260814T183000',
  'DTSTART;TZID=Europe/Berlin:20260814T170000',
  'EXDATE;TZID=Europe/Berlin:20260911T170000',
  'LAST-MODIFIED:20260916T142652Z',
  'PRIORITY:0',
  'RELATED-TO;RELTYPE=X-CALENDARSERVER-RECURRENCE-SET:33867f7f-c060-4c16-94f',
  ' a-713d4cba9917',
  'RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20260918T145959Z;BYDAY=FR',
  'SEQUENCE:108',
  'STATUS:CONFIRMED',
  'SUMMARY:My Appointment',
  'UID:gfajv96a54cdds8olkk9oa07uc@google.com',
  'X-OX-SPLIT-FROM:28b94c02-b193-4bd5-9460-042a042311d2',
  'END:VEVENT',
);

const OX_NEU = VCAL(
  ...TZ_BERLIN,
  'BEGIN:VEVENT',
  'DTSTAMP:20260916T142652Z',
  'CLASS:PUBLIC',
  'CREATED:20260916T142652Z',
  'DTEND;TZID=Europe/Berlin:20260918T201500',
  'DTSTART;TZID=Europe/Berlin:20260918T180000',
  'LAST-MODIFIED:20260916T142652Z',
  'PRIORITY:0',
  'RRULE:FREQ=WEEKLY;BYDAY=FR',
  'SEQUENCE:0',
  'SUMMARY:My Appointment',
  'TRANSP:OPAQUE',
  'UID:74aeda29-ec76-497c-8595-e8c4a3dc7656',
  'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
  'X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY',
  'END:VEVENT',
);

describe('#1269 - UNTIL mit Uhrzeit beendet die alte Serie vor dem Schnitttag', () => {
  it('OX-Schnitt (Europe/Berlin): der 18.09. traegt genau einen Termin, den neuen', async () => {
    const starts = await syncAndExpand([OX_ALT, OX_NEU], '2026-09-01', '2026-09-30');

    assert.deepEqual(am(starts, '2026-09-18'), ['2026-09-18T16:00:00Z'],
      `Schnitttag: nur die neue Serie (18:00 Berlin = 16:00Z), bekam: ${starts.join(' ')}`);
    assert.deepEqual(am(starts, '2026-09-04'), ['2026-09-04T15:00:00Z'],
      `davor die alte Serie (17:00 Berlin = 15:00Z), bekam: ${starts.join(' ')}`);
    assert.deepEqual(am(starts, '2026-09-11'), [],
      `EXDATE 11.09. bleibt leer, bekam: ${starts.join(' ')}`);
    assert.deepEqual(am(starts, '2026-09-25'), ['2026-09-25T16:00:00Z'],
      `danach nur die neue Serie, bekam: ${starts.join(' ')}`);
  });

  it('UNTIL ohne Zone wird in der Zone des Termins gelesen', async () => {
    // Dieselbe Serie, das Ende aber als ORTSZEIT geschrieben: 16:59:59 ist in
    // Europe/Berlin genau dasselbe wie 14:59:59Z. RFC 5545 verlangt bei einem
    // DTSTART mit TZID die UTC-Form - Server halten sich nicht immer daran.
    const ALT_OHNE_ZONE = OX_ALT.replace('UNTIL=20260918T145959Z', 'UNTIL=20260918T165959');
    assert.ok(ALT_OHNE_ZONE !== OX_ALT, 'die Ersetzung hat gegriffen');
    const starts = await syncAndExpand([ALT_OHNE_ZONE, OX_NEU], '2026-09-01', '2026-09-30');

    assert.deepEqual(am(starts, '2026-09-18'), ['2026-09-18T16:00:00Z'],
      `Schnitttag: nur die neue Serie, bekam: ${starts.join(' ')}`);
    assert.deepEqual(am(starts, '2026-09-04'), ['2026-09-04T15:00:00Z'],
      `davor die alte Serie, bekam: ${starts.join(' ')}`);
  });

  // WESTLICH VON UTC FAELLT DER SCHNITT AUF EINEN ANDEREN UTC-TAG ALS DER
  // ORTSTERMIN. 20:00 New York = 00:00Z des Folgetags: der Vergleich muss den
  // ZEITPUNKT treffen, nicht irgendeinen der beiden Kalendertage.
  const NY_ALT = (until) => VCAL(
    ...TZ_NEW_YORK,
    'BEGIN:VEVENT',
    'UID:ny-split-old@example',
    'SUMMARY:Late Call',
    'DTSTART;TZID=America/New_York:20260814T200000',
    'DTEND;TZID=America/New_York:20260814T210000',
    `RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=${until};BYDAY=FR`,
    'END:VEVENT',
  );

  const NY_NEU = VCAL(
    ...TZ_NEW_YORK,
    'BEGIN:VEVENT',
    'UID:ny-split-new@example',
    'SUMMARY:Late Call',
    'DTSTART;TZID=America/New_York:20260918T210000',
    'DTEND;TZID=America/New_York:20260918T220000',
    'RRULE:FREQ=WEEKLY;BYDAY=FR',
    'END:VEVENT',
  );

  it('Schnitt in America/New_York: der Zeitpunkt entscheidet, nicht der UTC-Tag', async () => {
    // 20:00 New York am 18.09. = 19.09. 00:00:00Z, das Ende also 18.09. 23:59:59Z.
    const starts = await syncAndExpand([NY_ALT('20260918T235959Z'), NY_NEU],
      '2026-09-01', '2026-09-30');

    assert.deepEqual(am(starts, '2026-09-19'), ['2026-09-19T01:00:00Z'],
      `Schnitttag: nur die neue Serie (21:00 New York), bekam: ${starts.join(' ')}`);
    assert.deepEqual(am(starts, '2026-09-12'), ['2026-09-12T00:00:00Z'],
      `davor die alte Serie (20:00 New York), bekam: ${starts.join(' ')}`);
  });

  it('UNTIL ist einschliessend: das Vorkommen GENAU auf der Grenze bleibt', async () => {
    // Dieselbe Serie, Ende eine Sekunde spaeter gesetzt - exakt auf ihrem
    // eigenen Start. RFC 5545: UNTIL schliesst ein.
    const starts = await syncAndExpand([NY_ALT('20260919T000000Z')], '2026-09-01', '2026-09-30');

    assert.deepEqual(am(starts, '2026-09-19'), ['2026-09-19T00:00:00Z'],
      `Grenzvorkommen bleibt, bekam: ${starts.join(' ')}`);
  });

  // Die reine Datumsform meint den GANZEN Tag. Wer UNTIL immer als Zeitpunkt
  // laese, wuerde Ganztagsserien ihren letzten Tag nehmen (Mitternacht ist ihr
  // Start, nicht ihr Ende).
  const GANZTAGS = (until) => VCAL(
    'BEGIN:VEVENT',
    'UID:allday@example',
    'SUMMARY:Ferien',
    'DTSTART;VALUE=DATE:20260901',
    'DTEND;VALUE=DATE:20260902',
    `RRULE:FREQ=DAILY;UNTIL=${until}`,
    'END:VEVENT',
  );

  it('Ganztagsserie mit reinem Datum: der UNTIL-Tag zaehlt noch dazu', async () => {
    const starts = await syncAndExpand([GANZTAGS('20260905')], '2026-09-01', '2026-09-30');
    assert.deepEqual(starts,
      ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'],
      `fuenf Tage einschliesslich des 05.09., bekam: ${starts.join(' ')}`);
  });

  it('Ganztagsserie mit Zeitangabe im UNTIL: bleibt beim Tag', async () => {
    // Manche Server schreiben trotz DTSTART;VALUE=DATE eine DATE-TIME. Ein
    // Ganztagstermin HAT keinen Zeitpunkt, an dem sich das messen liesse - der
    // Tag bleibt eingeschlossen, statt ihn an einer erfundenen Zone zu kuerzen.
    const starts = await syncAndExpand([GANZTAGS('20260905T000000Z')], '2026-09-01', '2026-09-30');
    assert.deepEqual(starts,
      ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'],
      `fuenf Tage einschliesslich des 05.09., bekam: ${starts.join(' ')}`);
  });
});
