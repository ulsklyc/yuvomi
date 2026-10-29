/**
 * Test: eingelesene Absagen treffen ihr Vorkommen ueber eine Zeitumstellung
 * hinweg (#2000, #2034 Schritt 5 - ICS-Abo, ICS-Import, CalDAV, iCloud).
 *
 * Die Importer legten EXDATE und RECURRENCE-ID als UTC-Tag ab (`YYYY-MM-DD`),
 * die Expansion fragte bei einer Serie mit eigener Zone den ORTSTAG ab. Wo die
 * beiden auseinandergehen, traf die Absage nichts oder das falsche Vorkommen:
 *   - New York woechentlich 19:30: im Winter liegt das Vorkommen vom 12.11. auf
 *     dem UTC-Tag 13.11. - die Absage des Anbieters blieb ohne Wirkung, und der
 *     Countdown (der den UTC-Tag las) widersprach dem Kalender;
 *   - Europe/Berlin taeglich 01:30, Start im Winter: nach der Umstellung liegt
 *     das Vorkommen vom 26.03. auf dem UTC-Tag 25.03. - die Absage strich den
 *     25.03. und liess den 26.03. stehen.
 * Los Angeles 23:30 (Ortstag != UTC-Tag schon am Start) traf auf main schon
 * richtig und steht hier als Gegenstueck: es darf nicht kippen.
 *
 * Seit Schritt 5 schreibt jeder dieser Importer den Schluessel in Format A
 * (RFC-Originalstart) und heilt beim Empfang die alte Zeile, die main fuer
 * denselben Rohwert geschrieben hatte.
 *
 * Nur Schnittstellen, die es auch auf main gibt: die Datei laeuft fuer die
 * Gegenprobe unveraendert gegen den Stand vor Schritt 5.
 *
 * Das Skript faehrt die Datei unter TZ=UTC und TZ=America/Chicago.
 * Ausfuehren: npm run test:occurrence-key-import
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDavServer } from './caldav-fake-server.js';

const db = (await import('../server/db.js')).get();
const { expandAndResolveEventRows } = await import('../server/services/calendar-event-reader.js');
const { getCountdowns } = await import('../server/services/countdowns.js');
const { parseICS, normalizeRecurrenceOverrides, expandRRULE } = await import('../server/services/ics-parser.js');
const { importToLocal } = await import('../server/services/ics-subscription.js');
const caldavSync = await import('../server/services/caldav-sync.js');
const { storeImportedExceptions } = await import('../server/services/imported-occurrence-key.js');
const appleCalendar = await import('../server/services/apple-calendar.js');

db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'admin', 'Admin', 'x', 'admin')").run();

const dav = await startFakeDavServer();
test.after(() => dav.close());

function setHousehold(zone) {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
}

beforeEach(() => {
  for (const table of [
    'calendar_event_exceptions', 'calendar_pending_deletions', 'calendar_events', 'external_calendars',
    'caldav_calendar_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  appleCalendar.clearCredentials();
  dav.reset();
});

/** Tag eines Zeitpunkts in einer Zone, eigene Intl-Rechnung. */
function dayIn(iso, zone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

function vcalendar(...lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
}

function vevent(uid, { start, end, rule, exdates = [], recurrenceId = null, summary = 'Serie' }) {
  return [
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20350101T000000Z', `SUMMARY:${summary}`,
    `DTSTART;${start}`, `DTEND;${end}`,
    ...(recurrenceId ? [`RECURRENCE-ID;${recurrenceId}`] : [`RRULE:${rule}`]),
    ...exdates.map((value) => `EXDATE;${value}`),
    'END:VEVENT',
  ];
}

// New York woechentlich 19:30, Start im Sommer (23:30Z). Umstellung 04.11.2035:
// das Vorkommen vom 12.11. liegt um 00:30Z des 13.11.
const NEW_YORK = {
  zone: 'America/New_York',
  ics: (extra = {}) => vcalendar(...vevent('ny@test', {
    start: 'TZID=America/New_York:20351001T193000', end: 'TZID=America/New_York:20351001T203000',
    rule: 'FREQ=WEEKLY', exdates: ['TZID=America/New_York:20351112T193000'], ...extra,
  })),
  window: ['2035-11-01', '2035-11-30'],
  expected: ['2035-11-05', '2035-11-19', '2035-11-26'],
  legacy: '2035-11-13',
};

// Europe/Berlin taeglich 01:30, Start im Winter (00:30Z). Umstellung 25.03.2035
// um 02:00: der 25.03. liegt um 00:30Z, der 26.03. um 23:30Z des 25.03. -
// zwei Vorkommen auf einem UTC-Tag. Abgesagt ist der 26.03.
const BERLIN = {
  zone: 'Europe/Berlin',
  ics: (extra = {}) => vcalendar(...vevent('berlin@test', {
    start: 'TZID=Europe/Berlin:20350320T013000', end: 'TZID=Europe/Berlin:20350320T023000',
    rule: 'FREQ=DAILY', exdates: ['TZID=Europe/Berlin:20350326T013000'], ...extra,
  })),
  window: ['2035-03-24', '2035-03-27'],
  expected: ['2035-03-24', '2035-03-25', '2035-03-27'],
  legacy: '2035-03-25',
};

// Los Angeles woechentlich 23:30: Ortstag und UTC-Tag gehen schon am Start
// auseinander (06:30Z am Folgetag). Auf main richtig - darf nicht kippen.
const LOS_ANGELES = {
  zone: 'America/Los_Angeles',
  ics: (extra = {}) => vcalendar(...vevent('la@test', {
    start: 'TZID=America/Los_Angeles:20351001T233000', end: 'TZID=America/Los_Angeles:20351002T003000',
    rule: 'FREQ=WEEKLY', exdates: ['TZID=America/Los_Angeles:20351112T233000'], ...extra,
  })),
  window: ['2035-11-01', '2035-11-30'],
  expected: ['2035-11-05', '2035-11-19', '2035-11-26'],
  legacy: '2035-11-13',
};

const CASES = { 'New York 19:30': NEW_YORK, 'Berlin 01:30': BERLIN, 'Los Angeles 23:30': LOS_ANGELES };

/** Ortstage der Vorkommen einer gespeicherten Serie, ueber den echten Lesepfad. */
function shownDays(zone, [from, to]) {
  const rows = db.prepare('SELECT * FROM calendar_events').all();
  return expandAndResolveEventRows(db, rows, from, to)
    .filter((event) => !event.is_occurrence_override)
    .map((event) => dayIn(event.start_datetime, zone))
    .sort();
}

function seriesRow() {
  const rows = db.prepare('SELECT * FROM calendar_events WHERE recurrence_rule IS NOT NULL').all();
  assert.equal(rows.length, 1, 'genau eine Serie');
  return rows[0];
}

function exceptionsOf(id) {
  return db.prepare('SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ? ORDER BY exception_date')
    .all(id).map((row) => row.exception_date);
}

function setupCalDav() {
  const accountId = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Fake', ?, 'u', 'p')
  `).run(dav.url).lastInsertRowid);
  const url = dav.addCollection('family', { name: 'Familie', components: ['VEVENT'] });
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Familie', '#4A90E2', 1)
  `).run(accountId, url);
  db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav', ?, 'Familie', '#4A90E2')
  `).run(url);
  return url;
}

function setupApple() {
  const url = dav.addCollection('icloud', { name: 'iCloud', components: ['VEVENT'] });
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  return url;
}

// ── ICS-Abo: flach ausgerollt, nichts gespeichert ──────────────────────────────

for (const [name, c] of Object.entries(CASES)) {
  test(`ICS-Abo, ${name}: die Absage des Anbieters trifft ihr Vorkommen`, () => {
    const [master] = normalizeRecurrenceOverrides(parseICS(c.ics()));
    const days = expandRRULE(master, c.window[0], `${c.window[1]}T23:59:59Z`)
      .map((instance) => dayIn(instance.dtstart, c.zone))
      .filter((day) => day >= c.window[0] && day <= c.window[1]);
    assert.deepEqual(days, c.expected);
  });
}

test('ICS-Abo, Berlin 01:30: ein geaendertes Einzelvorkommen ersetzt genau sein Original', () => {
  const ics = vcalendar(
    ...vevent('berlin@test', {
      start: 'TZID=Europe/Berlin:20350320T013000', end: 'TZID=Europe/Berlin:20350320T023000', rule: 'FREQ=DAILY',
    }),
    ...vevent('berlin@test', {
      start: 'TZID=Europe/Berlin:20350326T090000', end: 'TZID=Europe/Berlin:20350326T100000',
      recurrenceId: 'TZID=Europe/Berlin:20350326T013000', summary: 'Verschoben',
    }),
  );
  const [master] = normalizeRecurrenceOverrides(parseICS(ics)).filter((ev) => ev.rrule);
  const days = expandRRULE(master, '2035-03-24', '2035-03-27T23:59:59Z')
    .map((instance) => dayIn(instance.dtstart, 'Europe/Berlin'))
    .filter((day) => day >= '2035-03-24' && day <= '2035-03-27');
  assert.deepEqual(days, ['2035-03-24', '2035-03-25', '2035-03-27']);
});

test('ICS-Abo, Start in der Umstellungsnacht: die Absage greift wie auf main', () => {
  // Review zu #2300: `formatICSDate` liest einen DTSTART am Umstellungstag mit
  // der alten Uhr, die Vorkommen stehen eine Stunde neben dem Originalstart der
  // Absage. Dann bleibt es beim alten Tag.
  const ics = vcalendar(...vevent('dst@test', {
    start: 'TZID=America/New_York:20350311T033000', end: 'TZID=America/New_York:20350311T043000',
    rule: 'FREQ=DAILY;COUNT=3', exdates: ['TZID=America/New_York:20350312T033000'],
  }));
  const [master] = normalizeRecurrenceOverrides(parseICS(ics));
  const days = expandRRULE(master, '2035-03-10', '2035-03-15T23:59:59Z')
    .map((instance) => dayIn(instance.dtstart, 'America/New_York'));
  assert.deepEqual(days, ['2035-03-11', '2035-03-13']);
});

// ── CalDAV und iCloud: gespeichert, gelesen ueber Kalender und Countdown ────────

const STORED = {
  CalDAV: { setup: setupCalDav, sync: () => caldavSync.sync() },
  iCloud: { setup: setupApple, sync: () => appleCalendar.sync() },
};

for (const [way, w] of Object.entries(STORED)) {
  for (const [name, c] of Object.entries(CASES)) {
    test(`${way}, ${name}: Kalender und Countdown lassen genau das abgesagte Vorkommen aus`, async () => {
      setHousehold(c.zone);
      const url = w.setup();
      dav.putObject(url, 'series.ics', c.ics());
      await w.sync();
      assert.deepEqual(shownDays(c.zone, c.window), c.expected, 'Kalender');

      const series = seriesRow();
      db.prepare('UPDATE calendar_events SET countdown = 1 WHERE id = ?').run(series.id);
      const today = c.expected[0];
      const next = getCountdowns(db, { userId: 1, todayKey: shiftDay(today, 1) }).items
        .find((item) => item.id === series.id)?.date ?? null;
      assert.equal(next, c.expected[1], 'Countdown nennt dasselbe naechste Vorkommen wie der Kalender');
    });
  }

  test(`${way}, New York: die alte Zeile von main heilt beim naechsten Empfang`, async () => {
    setHousehold(NEW_YORK.zone);
    const url = w.setup();
    dav.putObject(url, 'series.ics', NEW_YORK.ics());
    await w.sync();
    const series = seriesRow();
    // So lag die Absage nach einem Sync auf main: der UTC-Tag des Vorkommens.
    db.prepare('DELETE FROM calendar_event_exceptions WHERE event_id = ?').run(series.id);
    db.prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
      .run(series.id, NEW_YORK.legacy);
    dav.putObject(url, 'series.ics', NEW_YORK.ics());
    await w.sync();
    assert.ok(!exceptionsOf(series.id).includes(NEW_YORK.legacy), 'die alte Zeile ist fort');
    assert.deepEqual(shownDays(NEW_YORK.zone, NEW_YORK.window), NEW_YORK.expected);
  });

  test(`${way}, New York taeglich: eine lokale Absage am UTC-Tag der Lieferung bleibt stehen`, async () => {
    // Review zu #2300: die alte Zeile `2035-11-13` kann die lokale Absage des
    // 13.11. sein - das Heilen fuer die Absage des 12.11. darf sie nicht nehmen.
    setHousehold(NEW_YORK.zone);
    const url = w.setup();
    const ics = NEW_YORK.ics({ rule: 'FREQ=DAILY' });
    dav.putObject(url, 'series.ics', ics);
    await w.sync();
    const series = seriesRow();
    db.prepare('DELETE FROM calendar_event_exceptions WHERE event_id = ?').run(series.id);
    db.prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
      .run(series.id, '2035-11-13');
    dav.putObject(url, 'series.ics', ics);
    await w.sync();
    const days = shownDays(NEW_YORK.zone, ['2035-11-11', '2035-11-14']);
    assert.deepEqual(days, ['2035-11-11', '2035-11-14'], 'weder der 12.11. noch der 13.11.');
  });

  test(`${way}, Berlin: zwei Absagen auf einem UTC-Tag bleiben zwei`, async () => {
    setHousehold(BERLIN.zone);
    const url = w.setup();
    dav.putObject(url, 'series.ics', BERLIN.ics({
      exdates: ['TZID=Europe/Berlin:20350325T013000', 'TZID=Europe/Berlin:20350326T013000'],
    }));
    await w.sync();
    assert.deepEqual(shownDays(BERLIN.zone, BERLIN.window), ['2035-03-24', '2035-03-27']);
  });
}

// ── Einmaliger ICS-Import ──────────────────────────────────────────────────────

test('ICS-Import ganztaegig: eine Datums-Absage bleibt ihr Tag', async () => {
  setHousehold('Europe/Berlin');
  const ics = vcalendar(
    'BEGIN:VEVENT', 'UID:allday@test', 'DTSTAMP:20350101T000000Z', 'SUMMARY:Ganztags',
    'DTSTART;VALUE=DATE:20350320', 'DTEND;VALUE=DATE:20350321', 'RRULE:FREQ=DAILY',
    'EXDATE;VALUE=DATE:20350326', 'END:VEVENT',
  );
  await importToLocal(1, { ics });
  const series = seriesRow();
  assert.deepEqual(exceptionsOf(series.id), ['2035-03-26']);
});

// #2306: der einmalige Import legte eine Serie ohne `tzid` ab. Ihre Vorkommen
// liefen dann auf der UTC-Uhr des Starts weiter, nach der Umstellung eine
// Stunde neben dem Originalstart der Absage - die traf nichts oder den
// Nachbartag. Mit `tzid` liest die Zeile wie CalDAV und iCloud.

// Europe/Berlin woechentlich 01:30, Start im Sommer (23:30Z am Vortag).
// Umstellung 28.10.2035: das Vorkommen vom 11.11. liegt um 00:30Z.
const BERLIN_WEEKLY = {
  zone: 'Europe/Berlin',
  ics: () => vcalendar(...vevent('berlin-weekly@test', {
    start: 'TZID=Europe/Berlin:20351007T013000', end: 'TZID=Europe/Berlin:20351007T023000',
    rule: 'FREQ=WEEKLY', exdates: ['TZID=Europe/Berlin:20351111T013000'],
  })),
  window: ['2035-11-01', '2035-11-30'],
  expected: ['2035-11-04', '2035-11-18', '2035-11-25'],
};

for (const [name, c] of Object.entries({ 'Berlin woechentlich 01:30': BERLIN_WEEKLY, ...CASES })) {
  test(`ICS-Import, ${name}: die Serie behaelt ihre Zone, die Absage trifft ihr Vorkommen`, async () => {
    setHousehold(c.zone);
    await importToLocal(1, { ics: c.ics() });
    const series = seriesRow();
    assert.deepEqual(shownDays(c.zone, c.window), c.expected, 'Kalender');
    assert.equal(series.tzid, c.zone, 'tzid des DTSTART bleibt an der Serie');

    db.prepare('UPDATE calendar_events SET countdown = 1 WHERE id = ?').run(series.id);
    const next = getCountdowns(db, { userId: 1, todayKey: shiftDay(c.expected[0], 1) }).items
      .find((item) => item.id === series.id)?.date ?? null;
    assert.equal(next, c.expected[1], 'Countdown nennt dasselbe naechste Vorkommen wie der Kalender');
  });
}

test('ICS-Import, Berlin woechentlich: eine Haushaltszone ausserhalb der Serie aendert nichts', async () => {
  setHousehold('America/Chicago');
  await importToLocal(1, { ics: BERLIN_WEEKLY.ics() });
  assert.deepEqual(shownDays(BERLIN_WEEKLY.zone, BERLIN_WEEKLY.window), BERLIN_WEEKLY.expected);
});

test('ICS-Import mit fremdem Zonennamen: die Serie bleibt ohne Zone', async () => {
  setHousehold('Europe/Berlin');
  const ics = vcalendar(...vevent('windows@test', {
    start: 'TZID=W. Europe Standard Time:20351007T013000', end: 'TZID=W. Europe Standard Time:20351007T023000',
    rule: 'FREQ=WEEKLY',
  }));
  await importToLocal(1, { ics });
  assert.equal(seriesRow().tzid, null);
});

test('ICS-Import ohne TZID: die Serie bleibt ohne Zone', async () => {
  setHousehold('Europe/Berlin');
  const ics = vcalendar(...vevent('utc@test', {
    start: 'VALUE=DATE-TIME:20351007T120000Z', end: 'VALUE=DATE-TIME:20351007T130000Z',
    rule: 'FREQ=WEEKLY',
  }));
  await importToLocal(1, { ics });
  assert.equal(seriesRow().tzid, null);
});

function shiftDay(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Budget des Heilens (Security-Review zu #2300) ─────────────────────────────

test('Heilen: hoechstens das Budget an Pruefungen je Lieferung, danach bleibt die alte Zeile', () => {
  // Woechentlich New York 19:30: jede Winter-Absage hat einen alten Tag, der
  // geprueft werden muss (der UTC-Folgetag). Zehn Absagen, Budget drei.
  setHousehold(NEW_YORK.zone);
  const id = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, tzid, recurrence_rule, created_by, external_source)
    VALUES ('Serie', '2035-10-01T23:30:00Z', '2035-10-02T00:30:00Z', 0, 'America/New_York', 'FREQ=WEEKLY', 1, 'caldav')
  `).run().lastInsertRowid);
  const raws = [];
  for (let week = 0; week < 10; week += 1) {
    const day = shiftDay('2035-11-12', 7 * week);
    const legacy = shiftDay(day, 1);
    raws.push({ value: `${day.replaceAll('-', '')}T193000`, tzid: 'America/New_York', isDate: false, legacy });
    db.prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)').run(id, legacy);
  }
  storeImportedExceptions(db, id, { exdateRaws: raws }, { healCheckBudget: 3 });
  const stored = exceptionsOf(id);
  assert.equal(stored.filter((key) => key.length === 10).length, 7, 'sieben alte Zeilen bleiben');
  assert.equal(stored.filter((key) => key.length > 10).length, 10, 'alle zehn exakten Schluessel stehen');
});
