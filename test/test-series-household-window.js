/**
 * Test: das Fenster eines Lesers ist in HAUSHALTSTAGEN gemeint, auch fuer eine
 * Serie mit eigener Zone (#1999, #2034 Schritt 2).
 *
 * Die Expansion lief eine Serie mit `tzid` auf dem Tag IHRER Zone (#985) und
 * verglich diesen Schleifentag direkt mit [from, to]. Die Leser bilden das
 * Fenster aber aus der Haushaltszone (`todayKey()`): die Suche ab heute, der
 * Kalender aus den Anzeigetagen. Liegen Haushalt und Serie in verschiedenen
 * Zonen, faellt ein Vorkommen nahe Mitternacht um einen Tag aus dem Fenster
 * heraus oder hinein:
 *   - Haushalt Berlin, Serie Los Angeles 23:30 Ortszeit: das Vorkommen des
 *     11.06. (LA) ist der 12.06. 08:30 in Berlin, also HEUTE - die Suche
 *     nannte trotzdem den naechsten Termin eine Woche spaeter.
 *   - Haushalt Berlin, Serie Tokio 01:00 Ortszeit: das Vorkommen des 12.06.
 *     (Tokio) ist der 11.06. 18:00 in Berlin, also GESTERN - die Suche nannte
 *     es als naechsten Termin.
 *
 * Jetzt fragt die Expansion, wenn der Leser die Zone seines Fensters nennt
 * (`windowZone`), nach dem Haushaltstag des Vorkommens. Nicht betroffen, und
 * hier gegen den Stand von main festgenagelt: Serien ohne `tzid`, ganztaegige
 * Serien und die Identitaetssuche der Einzelvorkommen (die ihr Fenster in
 * Schluesseltagen fuehrt und keine `windowZone` nennt).
 *
 * Erwartete Zeitpunkte sind von Hand nachgerechnet und werden zusaetzlich
 * gegen eine eigene `Intl`-Uhr geprueft. Das Skript faehrt die Datei unter
 * TZ=UTC und America/Chicago; der Haushalt steht auf Europe/Berlin. Die Tage
 * liegen 2035 (Sommerzeit in allen drei Zonen, keine Umstellung im Spiel).
 *
 * Ausfuehren: npm run test:series-household-window
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');
const { expandAndResolveEventRows } = await import('../server/services/calendar-event-reader.js');
const { resolveEventSearchRows } = await import('../server/services/search.js');

const HOUSEHOLD = 'Europe/Berlin';
db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(HOUSEHOLD);

/** Tag eines Zeitpunkts in einer Zone, eigene Intl-Rechnung. */
function dayIn(iso, zone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

function insertSeries({ title, start, end = null, tzid = null, allDay = 0, rule = 'FREQ=WEEKLY' }) {
  const id = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, tzid, recurrence_rule,
       created_by, color, icon, visibility)
    VALUES (?, ?, ?, ?, ?, ?, 1, '#007AFF', 'calendar', 'all')
  `).run(title, start, end, allDay, tzid, rule).lastInsertRowid;
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
}

// Los Angeles, woechentlich 23:30 PDT = 06:30Z des Folgetags = 08:30 Berlin.
const la = insertSeries({
  title: 'LA late', start: '2035-06-05T06:30:00Z', end: '2035-06-05T07:00:00Z',
  tzid: 'America/Los_Angeles',
});
// Tokio, woechentlich 01:00 JST = 16:00Z des Vortags = 18:00 Berlin am Vortag.
const tokyo = insertSeries({
  title: 'Tokyo early', start: '2035-06-04T16:00:00Z', end: '2035-06-04T17:00:00Z',
  tzid: 'Asia/Tokyo',
});
// Gegenfaelle, die sich nicht aendern duerfen.
const naive = insertSeries({ title: 'Local late', start: '2035-06-05T23:30', end: '2035-06-05T23:45' });
const allDay = insertSeries({
  title: 'All day', start: '2035-06-05', end: '2035-06-05', allDay: 1, tzid: 'America/Los_Angeles',
});

const TODAY = '2035-06-12'; // Haushaltstag "heute" der Suche
const SEARCH_TO = '2037-06-12';

test('Vorbedingung: die Serien liegen so, wie der Kopf sagt (eigene Intl-Uhr)', () => {
  assert.equal(dayIn('2035-06-12T06:30:00Z', 'America/Los_Angeles'), '2035-06-11');
  assert.equal(dayIn('2035-06-12T06:30:00Z', HOUSEHOLD), '2035-06-12');
  assert.equal(dayIn('2035-06-11T16:00:00Z', 'Asia/Tokyo'), '2035-06-12');
  assert.equal(dayIn('2035-06-11T16:00:00Z', HOUSEHOLD), '2035-06-11');
});

test('Suche: Serie in Los Angeles steht am Vorkommen, das im Haushalt HEUTE liegt', () => {
  const [hit] = resolveEventSearchRows(db, [la], TODAY, SEARCH_TO);
  assert.equal(hit.start_datetime, '2035-06-12T06:30:00Z');
  assert.equal(dayIn(hit.start_datetime, HOUSEHOLD), TODAY);
});

test('Suche: Serie in Tokio nennt kein Vorkommen, das im Haushalt GESTERN lag', () => {
  const [hit] = resolveEventSearchRows(db, [tokyo], TODAY, SEARCH_TO);
  assert.equal(hit.start_datetime, '2035-06-18T16:00:00Z');
  assert.ok(dayIn(hit.start_datetime, HOUSEHOLD) >= TODAY);
});

test('Kalender-Leser: ein Tag im Fenster ist ein Haushaltstag, an beiden Raendern', () => {
  const days = (rows, from, to) => expandAndResolveEventRows(db, rows, from, to)
    .map((row) => row.start_datetime);
  // LA: das Vorkommen vom LA-11.06. gehoert in Berlin zum 12.06.
  assert.deepEqual(days([la], '2035-06-11', '2035-06-11'), []);
  assert.deepEqual(days([la], '2035-06-12', '2035-06-12'), ['2035-06-12T06:30:00Z']);
  // Tokio: das Vorkommen vom Tokio-12.06. gehoert in Berlin zum 11.06. - auch
  // wenn der Schleifentag hinter dem Fensterende liegt.
  assert.deepEqual(days([tokyo], '2035-06-11', '2035-06-11'), ['2035-06-11T16:00:00Z']);
  assert.deepEqual(days([tokyo], '2035-06-12', '2035-06-12'), []);
});

test('Gegenfaelle wie auf main: ohne tzid, ganztaegig, ohne windowZone', () => {
  // Zonenlose Wanduhr ohne tzid: Schleifentag ist schon der Haushaltstag.
  const [naiveHit] = resolveEventSearchRows(db, [naive], TODAY, SEARCH_TO);
  assert.equal(naiveHit.start_datetime, '2035-06-12T23:30');
  assert.deepEqual(expandAndResolveEventRows(db, [naive], '2035-06-12', '2035-06-12')
    .map((row) => row.start_datetime), ['2035-06-12T23:30']);
  // Ganztaegig mit tzid: ein Datum, keine Uhr - bleibt auf seinem Tag.
  const [allDayHit] = resolveEventSearchRows(db, [allDay], TODAY, SEARCH_TO);
  assert.equal(allDayHit.start_datetime, '2035-06-12');
  // Ohne `windowZone` (Identitaetssuche der Einzelvorkommen) bleibt das
  // Fenster in Schleifentagen: das LA-Vorkommen vom 11.06. liegt darin.
  const raw = expandRecurringEvents([la], '2035-06-11', '2035-06-11', null, { includeRecurrenceIdentity: true });
  assert.deepEqual(raw.map((row) => [row.start_datetime, row.recurrence_identity]),
    // Seit #2034 Schritt 4 ist die Identitaet der Originalstart (Format A).
    [['2035-06-12T06:30:00Z', '2035-06-12T06:30:00Z']]);
});
