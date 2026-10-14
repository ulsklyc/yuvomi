/**
 * Test: ein zonenloser Start neben einer `tzid` ist Wanduhr des HAUSHALTS und
 * haengt nie an der Prozesszone (#1993).
 *
 * So eine Zeile entsteht, wenn eine eingelesene Serie aus dem Formular
 * gespeichert wird: PUT schreibt die Wanduhr-Ziffern des Haushalts
 * (`to: 'wall'`), die `tzid` bleibt stehen - unten am echten PUT gemessen.
 * Expansion und ICS-Feed lasen die Ziffern bis hierher mit `new Date()` in der
 * Zone des PROZESSES: dieselbe Zeile lieferte unter TZ=UTC, Europe/Berlin und
 * America/Los_Angeles drei verschiedene Serien. CalDAV und iCloud schickten
 * die Ziffern roh mit `TZID=<tzid>`, also in der falschen Uhr, sobald Haushalt
 * und Serie in verschiedenen Zonen liegen.
 *
 * Zwei Zeilen meinen hier dieselbe Serie (taeglich 23:30 in Los Angeles):
 *   - Haushalt = tzid (beide Los Angeles): Ziffern `2035-10-01T23:30`;
 *   - Haushalt Berlin, tzid Los Angeles:    Ziffern `2035-10-02T08:30`.
 * Erwartet ist fuer beide dasselbe, nachgerechnet mit einer eigenen
 * `Intl`-Uhr, nicht durch den Leser unter Test. Gemessen werden Expansion
 * (direkt und ueber den Leser des Kalenders), Feed (DTSTART, DTEND, EXDATE),
 * CalDAV-Aenderung, CalDAV-Neuanlage und iCloud-Neuanlage, dazu die Tagesfrage
 * (`storedDayDiffersFromSeriesDay`) und eine Monatsletzten-Serie.
 *
 * Bestandszeilen: eine Titelaenderung an der eingelesenen Serie setzt weder
 * die Marke `series_authored` (#1935) noch einen Sende-Schnappschuss (#1956).
 *
 * Das Skript faehrt die Datei unter TZ=UTC, Europe/Berlin und America/Los_Angeles.
 * Die Tage liegen 2035.
 *
 * Ausfuehren: npm run test:naive-start-in-tzid
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const db = (await import('../server/db.js')).get();
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');
const { expandAndResolveEventRows } = await import('../server/services/calendar-event-reader.js');
const { __test: feed } = await import('../server/services/ics-export.js');
const { icsFieldsForEvent } = await import('../server/services/caldav-outbound.js');
const { __test: caldav } = await import('../server/services/caldav-sync.js');
const { __test: apple } = await import('../server/services/apple-calendar.js');
const { icsSnapshot } = await import('../server/services/outbound-echo.js');
const { storedDayDiffersFromSeriesDay } = await import('../server/utils/timezone.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

function setHousehold(zone) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(zone);
}

// ── Unabhaengige Uhr ────────────────────────────────────────────────────────

/** Wanduhr `YYYY-MM-DDTHH:MM` in `zone` -> UTC-Instant `...Z`. */
function wallToUtc(wall, zone) {
  const guess = Date.parse(`${wall}:00Z`);
  const shown = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms));
    const g = (t) => parts.find((p) => p.type === t).value;
    return Date.parse(`${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}Z`);
  };
  const first = guess - (shown(guess) - guess);
  const ms = guess - (shown(first) - first);
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

// ── Die zwei Zeilen ─────────────────────────────────────────────────────────

const RULE = 'RRULE:FREQ=DAILY;UNTIL=20351011T065959Z';
const CASES = [
  { name: 'Haushalt = tzid', household: LA, start: '2035-10-01T23:30', end: '2035-10-01T23:45' },
  { name: 'Haushalt Berlin, tzid Los Angeles', household: BERLIN, start: '2035-10-02T08:30', end: '2035-10-02T08:45' },
];
const rowFor = (c, extra = {}) => ({
  id: 1, title: 'Import', all_day: 0, tzid: LA, series_authored: 0,
  start_datetime: c.start, end_datetime: c.end, recurrence_rule: RULE, ...extra,
});

// Die Serie, die beide Zeilen meinen: 01.-10. Oktober, 23:30-23:45 in LA.
const FIRST = wallToUtc('2035-10-01T23:30', LA);
const LAST = wallToUtc('2035-10-10T23:30', LA);
const LAST_END = wallToUtc('2035-10-10T23:45', LA);
const DTSTART = `DTSTART;TZID=${LA}:20351001T233000`;
const DTEND = `DTEND;TZID=${LA}:20351001T234500`;

/** DTSTART/DTEND-Zeilen des VEVENT (nicht die des VTIMEZONE-Blocks). */
function timeLines(ics) {
  const lines = String(ics).split(/\r?\n/);
  const from = lines.indexOf('BEGIN:VEVENT');
  return lines.slice(from).filter((l) => /^DT(START|END)/.test(l));
}

for (const c of CASES) {
  test(`TZ=${process.env.TZ}, ${c.name}: die Expansion liest die Ziffern in der Haushaltszone`, () => {
    const out = expandRecurringEvents([rowFor(c)], '2035-09-01', '2035-12-31', null, { householdZone: c.household });
    assert.equal(out.length, 10);
    assert.equal(out[0].start_datetime, FIRST);
    assert.equal(out.at(-1).start_datetime, LAST);
    assert.equal(out.at(-1).end_datetime, LAST_END);
  });

  test(`TZ=${process.env.TZ}, ${c.name}: der Leser des Kalenders reicht die Haushaltszone herein`, () => {
    setHousehold(c.household);
    const out = expandAndResolveEventRows(db, [rowFor(c)], '2035-09-01', '2035-12-31');
    assert.deepEqual(out.map((o) => o.start_datetime), Array.from({ length: 10 }, (_, i) =>
      wallToUtc(`2035-10-${String(i + 1).padStart(2, '0')}T23:30`, LA)));
  });

  test(`TZ=${process.env.TZ}, ${c.name}: der Feed schreibt die Wanduhr der Serie, EXDATE trifft das Vorkommen`, () => {
    // Die Ausnahme ist der UTC-Tag des dritten Vorkommens (03.10. 23:30 LA).
    const exUtcDay = wallToUtc('2035-10-03T23:30', LA).slice(0, 10);
    const lines = feed.buildVEvent(rowFor(c, { exception_dates: [exUtcDay] }), '20260101T000000Z', false, c.household);
    assert.ok(lines.includes(DTSTART), lines.join('\n'));
    assert.ok(lines.includes(DTEND), lines.join('\n'));
    assert.ok(lines.includes(`EXDATE;TZID=${LA}:20351003T233000`), lines.join('\n'));
  });

  test(`TZ=${process.env.TZ}, ${c.name}: CalDAV und iCloud senden dieselbe Wanduhr`, () => {
    const fields = icsFieldsForEvent(rowFor(c), c.household).fields;
    assert.equal(`DTSTART${fields.DTSTART.params}:${fields.DTSTART.value}`, DTSTART);
    assert.equal(`DTEND${fields.DTEND.params}:${fields.DTEND.value}`, DTEND);
    for (const [label, ics] of [
      ['CalDAV-Neuanlage', caldav.buildCalDAVICS(rowFor(c), c.household)],
      ['iCloud-Neuanlage', apple.buildICS(rowFor(c), c.household)],
    ]) {
      assert.deepEqual(timeLines(ics), [DTSTART, DTEND], label);
      assert.match(String(ics), new RegExp(`TZID:${LA}`), `${label}: VTIMEZONE fehlt`);
    }
  });
}

test(`TZ=${process.env.TZ}: die Tagesfrage liest zonenlose Ziffern in der Haushaltszone`, () => {
  // 01.11. 05:30 Berlin = 31.10. 21:30 Los Angeles: der Tag im Text ist nicht
  // der Ortstag der Serie.
  assert.equal(storedDayDiffersFromSeriesDay('2035-11-01T05:30', LA, BERLIN), true);
  // Dieselben Ziffern im Haushalt Los Angeles: derselbe Tag.
  assert.equal(storedDayDiffersFromSeriesDay('2035-11-01T05:30', LA, LA), false);
  assert.equal(storedDayDiffersFromSeriesDay('2035-11-01T05:30', null, BERLIN), false);
});

test(`TZ=${process.env.TZ}: eine Monatsletzten-Serie beginnt am Ortsletzten der Serienzone`, () => {
  const row = {
    id: 2, title: 'Monatsletzter', all_day: 0, tzid: LA,
    start_datetime: '2035-11-01T05:30', end_datetime: '2035-11-01T06:00',
    recurrence_rule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=2',
  };
  const out = expandRecurringEvents([row], '2035-10-01', '2036-01-31', null, { householdZone: BERLIN });
  assert.deepEqual(out.map((o) => o.start_datetime), [
    wallToUtc('2035-10-31T21:30', LA),
    wallToUtc('2035-11-30T21:30', LA),
  ]);
});

// ── Der Bestandsfall ueber die echte Route ──────────────────────────────────

const app = express();
app.use((req, _res, next) => {
  req.authUserId = 1;
  req.authRole = 'admin';
  req.session = { userId: 1, role: 'admin' };
  next();
});
app.use(express.json());
app.use('/', calendarRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => { server.closeAllConnections?.(); server.close(); });

test(`TZ=${process.env.TZ}: PUT aus dem Formular schreibt Haushaltsziffern neben die tzid, der Kalender zeigt dieselbe Serie`, async () => {
  setHousehold(BERLIN);
  const id = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid,
      external_source, external_calendar_id, created_by)
    VALUES ('Import', ?, ?, 0, ?, ?, 'caldav', 'uid-1993', 1)
  `).run(FIRST, wallToUtc('2035-10-01T23:45', LA), RULE, LA).lastInsertRowid);

  // Das Formular zeigt den Zeitpunkt in Berlin und schickt diese Ziffern zurueck.
  const res = await fetch(`${baseUrl}/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Import (umbenannt)', all_day: false, recurrence_rule: RULE,
      start_datetime: '2035-10-02T08:30', end_datetime: '2035-10-02T08:45',
    }),
  });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  assert.equal(row.start_datetime, '2035-10-02T08:30');
  assert.equal(row.tzid, LA);
  // Nur der Titel hat sich geaendert: keine Marke (#1935) ...
  assert.equal(Number(row.series_authored), 0);
  // ... und ohne Ausrichtung kein Sende-Schnappschuss (#1956).
  assert.equal(icsSnapshot(row, caldav.buildCalDAVICS(row, BERLIN), 'uid-1993', BERLIN), null);

  const list = await (await fetch(`${baseUrl}/?from=2035-09-25&to=2035-10-20`)).json();
  const starts = list.data.filter((e) => Number(e.id) === id).map((e) => e.start_datetime);
  assert.equal(starts.length, 10);
  assert.equal(starts[0], FIRST);
  assert.equal(starts.at(-1), LAST);
});
