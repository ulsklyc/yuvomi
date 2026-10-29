/**
 * Test: die Fensterleser setzen eine Serie nahe am Fenster ein, nicht an
 * DTSTART (#2341, #2226).
 *
 * `GET /calendar` reicht `expandAndResolveEventRows()` ohne Optionen weiter,
 * also mit der Standardgrenze von 1000 Schleifenschritten. Gezaehlt wurde ab
 * DTSTART: eine taegliche Serie, die vor mehr als gut 1000 Tagen begann, kam
 * nie im Fenster an und fehlte in der Kalenderansicht ganz. Dashboard und
 * `/calendar/upcoming` reichen die grosse Grenze herein und zeigten sie - nur
 * langsam, weil jeder Aufruf alle Vorkommen seit DTSTART durchlief.
 *
 * Jetzt springt die Expansion bei einer Regel ohne COUNT bis kurz vor das
 * Fenster (`resumeAtWindow`, derselbe Sprung wie fuer die Countdowns, #1998).
 * Festgenagelt wird die AEQUIVALENZ: fuer jede Regelart liefert der Leser
 * dieselben Vorkommen wie eine Expansion ohne Sprung mit der grossen Grenze -
 * auch an den Raendern (mehrtaegige Termine, die vor dem Fenster beginnen,
 * Serien in anderen Zonen, UNTIL, COUNT).
 *
 * Ausfuehren: npm run test:calendar-window-resume
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const { expandAndResolveEventRows } = await import('../server/services/calendar-event-reader.js');
const { MAX_EXPANSION_ITERATIONS } = await import('../server/services/calendar-events.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();

function insertSeries({ title, start, end = null, tzid = null, allDay = 0, rule }) {
  const id = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, tzid, recurrence_rule,
       created_by, color, icon, visibility)
    VALUES (?, ?, ?, ?, ?, ?, 1, '#007AFF', 'calendar', 'all')
  `).run(title, start, end, allDay, tzid, rule).lastInsertRowid;
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
}

const starts = (rows) => rows.map((row) => `${row.id}@${row.start_datetime}`);
// So liest GET /calendar (server/routes/calendar/read.js): keine Optionen.
const reader = (rows, from, to) => starts(expandAndResolveEventRows(db, rows, from, to));
// Die Referenz: ab DTSTART, ohne Sprung, mit der grossen Grenze.
const reference = (rows, from, to) => starts(expandAndResolveEventRows(db, rows, from, to, {
  expansion: { maxIterations: MAX_EXPANSION_ITERATIONS, resumeAtWindow: false },
}));

test('eine taegliche Serie von 2020 steht im November 2026 im Kalender', () => {
  const daily = insertSeries({
    title: 'Daily since 2020', start: '2020-01-06T08:00:00Z', end: '2020-01-06T08:30:00Z',
    tzid: 'Europe/Berlin', rule: 'FREQ=DAILY',
  });
  const got = reader([daily], '2026-11-01', '2026-11-30');
  assert.equal(got.length, 30, `${got.length} Vorkommen statt 30 - die Serie kam nie im Fenster an`);
  assert.deepEqual(got, reference([daily], '2026-11-01', '2026-11-30'));
  // Der Sprung selbst, nicht nur die grosse Grenze: mit 1000 Schritten, wie
  // vorher, kommt die Serie nur an, wenn die Schleife kurz vor dem Fenster
  // einsetzt - die Arbeit haengt am Fenster, nicht am Alter der Serie.
  const small = starts(expandAndResolveEventRows(db, [daily], '2026-11-01', '2026-11-30', {
    expansion: { maxIterations: 1000 },
  }));
  assert.deepEqual(small, got);
});

const SERIES = [
  { title: 'daily, timed, Berlin', start: '2019-03-04T07:00:00Z', end: '2019-03-04T08:00:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=DAILY' },
  { title: 'daily, naive wall clock', start: '2019-03-04T23:30', end: '2019-03-04T23:45', rule: 'FREQ=DAILY' },
  { title: 'every 3 days', start: '2018-05-01T10:00:00Z', end: '2018-05-01T11:00:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=DAILY;INTERVAL=3' },
  { title: 'weekdays', start: '2017-01-02T06:00:00Z', end: '2017-01-02T06:30:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { title: 'daily on weekdays', start: '2017-01-02T06:00:00Z', end: '2017-01-02T06:30:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=DAILY;BYDAY=MO,WE,FR' },
  { title: 'every second week', start: '2016-02-03T17:00:00Z', end: '2016-02-03T18:00:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=WEEKLY;INTERVAL=2' },
  { title: 'monthly on the 31st', start: '2015-01-31T09:00:00Z', end: '2015-01-31T10:00:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=MONTHLY' },
  { title: 'second Tuesday', start: '2015-01-13T18:00:00Z', end: '2015-01-13T19:00:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=MONTHLY;BYDAY=2TU' },
  { title: 'yearly birthday', start: '1950-11-03', end: '1950-11-03', allDay: 1, rule: 'FREQ=YEARLY' },
  { title: 'four-day all-day block, weekly', start: '2018-01-04', end: '2018-01-08', allDay: 1, rule: 'FREQ=WEEKLY' },
  { title: 'six-day all-day block, daily', start: '2018-01-04', end: '2018-01-10', allDay: 1, rule: 'FREQ=DAILY' },
  { title: 'sixteen-day all-day block, weekly', start: '2018-01-04', end: '2018-01-20', allDay: 1, rule: 'FREQ=WEEKLY' },
  { title: 'Los Angeles late evening', start: '2019-06-05T06:30:00Z', end: '2019-06-05T07:00:00Z', tzid: 'America/Los_Angeles', rule: 'FREQ=DAILY' },
  { title: 'Tokyo early morning', start: '2019-06-04T16:00:00Z', end: '2019-06-04T17:00:00Z', tzid: 'Asia/Tokyo', rule: 'FREQ=DAILY' },
  { title: 'ends inside the window', start: '2019-01-01T08:00:00Z', end: '2019-01-01T09:00:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=DAILY;UNTIL=20261115T235959Z' },
  { title: 'ended before the window', start: '2019-01-01T08:00:00Z', end: '2019-01-01T09:00:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=DAILY;UNTIL=20251231T235959Z' },
  { title: 'COUNT reaches the window', start: '2020-01-01T08:00:00Z', end: '2020-01-01T09:00:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=DAILY;COUNT=2500' },
];

for (const spec of SERIES) {
  test(`gleich wie ab DTSTART: ${spec.title}`, () => {
    const row = insertSeries(spec);
    for (const [from, to] of [['2026-11-01', '2026-11-30'], ['2026-11-07', '2026-11-07'], ['2026-03-29', '2026-03-29']]) {
      assert.deepEqual(reader([row], from, to), reference([row], from, to), `${from}..${to}`);
    }
  });
}

test('der vierttaegige Block, der vor dem Fenster beginnt, ragt weiter hinein', () => {
  const block = insertSeries({ title: 'block', start: '2018-01-04', end: '2018-01-08', allDay: 1, rule: 'FREQ=WEEKLY' });
  // 2026-11-05 ist ein Donnerstag: der Block vom 05.11. laeuft bis 09.11.
  assert.deepEqual(reader([block], '2026-11-08', '2026-11-08'), [`${block.id}@2026-11-05`]);
});

test('ein beliebig weites Fenster bleibt je Serie bei der Standardgrenze', () => {
  // GET /calendar nimmt from/to ungeprueft. Die grosse Grenze haette einer
  // taeglichen Serie ueber 1900..2200 bis zu 100000 Schritte und Zeilen je
  // Anfrage erlaubt; mit dem Sprung reicht die Standardgrenze fuer jedes
  // Fenster bis gut 1000 Tage, und weiter gehen nur Serien mit COUNT - bis zu
  // ihrem COUNT, den sie selbst begrenzen.
  const daily = insertSeries({
    title: 'Daily wide', start: '2020-01-06T08:00:00Z', end: '2020-01-06T08:30:00Z',
    tzid: 'Europe/Berlin', rule: 'FREQ=DAILY',
  });
  const rows = reader([daily], '1900-01-01', '2200-12-31');
  assert.ok(rows.length > 0 && rows.length <= 1000, `${rows.length} Vorkommen aus einem 300-Jahre-Fenster`);
});
