/**
 * Test: der Schluessel eines Serien-Vorkommens (#2034, Schritt 4).
 *
 * Format A, der RECURRENCE-ID von RFC 5545 nachgebaut:
 *   - ganztaegig `YYYY-MM-DD` (der Serientag),
 *   - mit Zone `YYYY-MM-DDTHH:MM:SSZ` (der Originalstart als UTC-Zeitpunkt),
 *   - schwebend `YYYY-MM-DDTHH:MM:SS` (Wanduhr ohne Zone, ohne `tzid`).
 * Die alte Form `YYYY-MM-DD` an einer getimten Serie bleibt lesbar und meint,
 * was sie auf main meinte (test-occurrence-key-legacy.js haelt das gegen einen
 * Golden Snapshot fest).
 *
 * Hier: die Uhr (`occurrenceClock`) und die Suche eines Vorkommens nach seinem
 * Schluessel (`baseOccurrenceFor`) in beiden Formen.
 *
 * Erwartete Zeitpunkte von Hand nachgerechnet. Das Skript faehrt die Datei
 * unter TZ=UTC und TZ=America/Chicago; der Haushalt steht auf Europe/Berlin.
 *
 * Ausfuehren: npm run test:occurrence-key
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const { occurrenceClock, isOccurrenceKey } = await import('../server/services/calendar-events.js');
const {
  baseOccurrenceFor, CalendarOccurrenceError, resolveEventRows,
} = await import('../server/services/calendar-occurrence-overrides.js');

const HOUSEHOLD = 'Europe/Berlin';
db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(HOUSEHOLD);

const SERIES = {
  // Europe/Berlin taeglich 01:30, Start im Sommer 2034: Schleife auf Ortstagen.
  berlinNight: {
    id: 1, title: 'Nacht', start_datetime: '2034-06-30T23:30:00Z', end_datetime: '2034-07-01T00:30:00Z',
    tzid: 'Europe/Berlin', recurrence_rule: 'FREQ=DAILY', all_day: 0,
  },
  // Los Angeles woechentlich montags 23:30 = 06:30Z am Dienstag.
  la: {
    id: 2, title: 'LA', start_datetime: '2035-06-12T06:30:00Z', end_datetime: '2035-06-12T07:30:00Z',
    tzid: 'America/Los_Angeles', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', all_day: 0,
  },
  floating: {
    id: 3, title: 'Lokal', start_datetime: '2035-03-20T01:30', end_datetime: '2035-03-20T02:30',
    tzid: null, recurrence_rule: 'FREQ=DAILY', all_day: 0,
  },
  allDay: {
    id: 4, title: 'Ganztag', start_datetime: '2035-03-20', end_datetime: '2035-03-20',
    tzid: null, recurrence_rule: 'FREQ=WEEKLY', all_day: 1,
  },
  // #1993: `tzid` und zonenlose Ziffern - Wanduhr des Haushalts (Berlin).
  naiveInTzid: {
    id: 5, title: '1993', start_datetime: '2035-03-20T19:30', end_datetime: '2035-03-20T20:30',
    tzid: 'America/New_York', recurrence_rule: 'FREQ=DAILY', all_day: 0,
  },
  // Google: Start mit Offset und `tzid`.
  google: {
    id: 6, title: 'Google', start_datetime: '2035-10-30T19:30:00-04:00', end_datetime: '2035-10-30T20:30:00-04:00',
    tzid: 'America/New_York', recurrence_rule: 'FREQ=DAILY', all_day: 0,
  },
};

test('isOccurrenceKey nimmt genau die drei Formen', () => {
  for (const key of ['2035-03-24', '2035-03-24T23:30:00Z', '2035-03-24T01:30:00']) {
    assert.equal(isOccurrenceKey(key), true, key);
  }
  for (const key of ['2035-02-30', '2035-03-24T23:30Z', '2035-03-24T25:00:00Z', '2035-03-24T01:30:00+01:00', '', null, 20350324]) {
    assert.equal(isOccurrenceKey(key), false, String(key));
  }
});

test('keyFor: je Uhr die passende Form', () => {
  const key = (series, day) => occurrenceClock(series, HOUSEHOLD).keyFor(day);
  assert.equal(key(SERIES.berlinNight, '2035-03-25'), '2035-03-25T00:30:00Z');
  assert.equal(key(SERIES.berlinNight, '2035-03-26'), '2035-03-25T23:30:00Z');
  assert.equal(key(SERIES.la, '2035-06-18'), '2035-06-19T06:30:00Z');
  assert.equal(key(SERIES.floating, '2035-03-25'), '2035-03-25T01:30:00');
  assert.equal(key(SERIES.allDay, '2035-03-27'), '2035-03-27');
  // 19:30 Berlin am 20.03. = 18:30Z = 14:30 New York; nach der US-Umstellung
  // (11.03.) bleibt die Wanduhr der Serienzone 14:30.
  assert.equal(key(SERIES.naiveInTzid, '2035-03-25'), '2035-03-25T18:30:00Z');
  // Google 19:30 New York: im November (EST) 00:30Z am Folgetag.
  assert.equal(key(SERIES.google, '2035-11-05'), '2035-11-06T00:30:00Z');
});

test('legacyKeyFor: die Lesart von main, samt der Kollision in der Umstellungsnacht', () => {
  const clock = occurrenceClock(SERIES.berlinNight, HOUSEHOLD);
  assert.equal(clock.legacyKeyFor('2035-03-24'), '2035-03-24');
  assert.equal(clock.legacyKeyFor('2035-03-25'), '2035-03-24');
  assert.equal(clock.legacyKeyFor('2035-03-26'), '2035-03-25');
  // Google: die alte Form war der Ortstag (#2000), nicht der UTC-Tag.
  assert.equal(occurrenceClock(SERIES.google, HOUSEHOLD).legacyKeyFor('2035-11-05'), '2035-11-05');
});

test('dayCandidatesOfKey: exakt hoechstens ein Tag, alt bis zu zwei', () => {
  const clock = occurrenceClock(SERIES.berlinNight, HOUSEHOLD);
  assert.deepEqual(clock.dayCandidatesOfKey('2035-03-24'), ['2035-03-24', '2035-03-25']);
  assert.deepEqual(clock.dayCandidatesOfKey('2035-03-25T00:30:00Z'), ['2035-03-25']);
  assert.deepEqual(clock.dayCandidatesOfKey('2035-03-25T23:30:00Z'), ['2035-03-26']);
  assert.deepEqual(clock.dayCandidatesOfKey('2035-03-25T22:30:00Z'), [], 'kein Vorkommen um 22:30Z');
  assert.deepEqual(occurrenceClock(SERIES.la, HOUSEHOLD).dayCandidatesOfKey('2035-06-19T06:30:00Z'), ['2035-06-18']);
  assert.deepEqual(occurrenceClock(SERIES.floating, HOUSEHOLD).dayCandidatesOfKey('2035-03-25T01:30:00'), ['2035-03-25']);
  assert.deepEqual(occurrenceClock(SERIES.allDay, HOUSEHOLD).dayCandidatesOfKey('2035-03-27'), ['2035-03-27']);
  // Ordnung innerhalb der Serie: die Lage, nicht der Text.
  assert.ok(clock.keyOrder('2035-03-25T23:30:00Z') > clock.keyOrder('2035-03-25T00:30:00Z'));
  assert.equal(clock.keyOrder('2035-03-24'), '2035-03-24');
});

test('baseOccurrenceFor: Format A trifft genau ein Vorkommen', () => {
  const slot = baseOccurrenceFor(SERIES.berlinNight, '2035-03-25T00:30:00Z', HOUSEHOLD);
  assert.equal(slot.start_datetime, '2035-03-25T00:30:00Z');
  const next = baseOccurrenceFor(SERIES.berlinNight, '2035-03-25T23:30:00Z', HOUSEHOLD);
  assert.equal(next.start_datetime, '2035-03-25T23:30:00Z');
  assert.equal(baseOccurrenceFor(SERIES.la, '2035-06-19T06:30:00Z', HOUSEHOLD).start_datetime, '2035-06-19T06:30:00Z');
  assert.equal(baseOccurrenceFor(SERIES.floating, '2035-03-25T01:30:00', HOUSEHOLD).start_datetime, '2035-03-25T01:30');
});

test('baseOccurrenceFor: die alte Form trifft, was sie auf main traf; zwei Treffer nur auf Wunsch 409', () => {
  // Wie auf main: das erste der beiden Vorkommen.
  assert.equal(baseOccurrenceFor(SERIES.berlinNight, '2035-03-24', HOUSEHOLD).start_datetime, '2035-03-24T00:30:00Z');
  assert.equal(baseOccurrenceFor(SERIES.berlinNight, '2035-03-25', HOUSEHOLD).start_datetime, '2035-03-25T23:30:00Z');
  assert.throws(
    () => baseOccurrenceFor(SERIES.berlinNight, '2035-03-24', HOUSEHOLD, { ambiguous: 'reject' }),
    (error) => error instanceof CalendarOccurrenceError && error.status === 409 && error.code === 'ambiguous_recurrence_id',
  );
  // Ein Treffer bleibt auch mit `reject` gueltig.
  assert.equal(
    baseOccurrenceFor(SERIES.berlinNight, '2035-03-25', HOUSEHOLD, { ambiguous: 'reject' }).start_datetime,
    '2035-03-25T23:30:00Z',
  );
  assert.throws(
    () => baseOccurrenceFor(SERIES.berlinNight, '2035-03-25T22:30:00Z', HOUSEHOLD),
    (error) => error.status === 400 && error.code === 'invalid_recurrence_id',
  );
  assert.throws(
    () => baseOccurrenceFor(SERIES.berlinNight, '25.03.2035', HOUSEHOLD),
    (error) => error.status === 400 && error.code === 'invalid_recurrence_id',
  );
});

test('Kindzuordnung: ein verknuepftes Vorkommen mit exaktem Schluessel loest auf seinen Slot auf', () => {
  const masterId = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, tzid, recurrence_rule, created_by)
    VALUES ('Nacht', '2034-06-30T23:30:00Z', '2034-07-01T00:30:00Z', 0, 'Europe/Berlin', 'FREQ=DAILY', 1)
  `).run().lastInsertRowid);
  const insertChild = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by,
      recurrence_parent_id, recurrence_id, overridden_fields)
    VALUES (?, '2035-03-30T10:00:00Z', '2035-03-30T11:00:00Z', 0, 1, ?, ?, '["title"]')
  `);
  insertChild.run('exakt', masterId, '2035-03-25T00:30:00Z');
  insertChild.run('alt', masterId, '2035-03-24');
  const children = db.prepare('SELECT * FROM calendar_events WHERE recurrence_parent_id = ? ORDER BY id').all(masterId);
  const [exact, legacy] = resolveEventRows(db, children);
  assert.equal(exact.title, 'exakt');
  assert.equal(exact.start_datetime, '2035-03-25T00:30:00Z', 'Start aus dem Slot, nicht aus der Zeile');
  assert.equal(exact.recurrence_id, '2035-03-25T00:30:00Z');
  assert.equal(exact.is_occurrence_override, true);
  assert.equal(legacy.start_datetime, '2035-03-24T00:30:00Z', 'alte Form: das erste Vorkommen, wie auf main');
  assert.equal(legacy.recurrence_id, '2035-03-24');
});
