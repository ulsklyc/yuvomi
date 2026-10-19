/**
 * Test: Schreiber und Vergleicher auf dem Schluessel in Format A (#2034, Schritt 4b).
 *
 * Jeder Fall war auf main falsch, und jeder benutzt den Schluessel, den der
 * Kalender selbst ausgibt (`recurrence_identity` ueber den echten Lesepfad) -
 * so, wie das Frontend ihn zuruecksendet:
 *   - Europe/Berlin taeglich 01:30, Start im Sommer: "nur dieser" am 25.03.2035
 *     loeschte auch den 24.03. (beide trugen den Tag `2035-03-24`); dazu der
 *     28.10.2035 als Gegenstueck im Herbst.
 *   - Los Angeles woechentlich 23:30: "dieser und folgende" kuerzte die Regel
 *     auf den UTC-Vortag, das gewaehlte Vorkommen blieb in der alten Serie und
 *     stand in der neuen ein zweites Mal.
 *   - COUNT oestlich von UTC (Tokio): "dieser und folgende" scheiterte, weil
 *     das Zaehlfenster am UTC-Tag endete, einen Tag VOR dem Schleifentag.
 *   - Die alte Form als Eingabe: eindeutig 200, in der Umstellungsnacht 409
 *     `ambiguous_recurrence_id` statt still das erste Vorkommen.
 *   - Countdown (#1998): Serie Los Angeles im Berliner Haushalt, mit Absage.
 *   - Wechsel der Haushaltszone (F5): eine Serie mit `tzid` und zonenlosem
 *     Start (#1993) behaelt Ausnahme und Einzelvorkommen an ihrem Tag.
 *
 * Nur Schnittstellen, die es auch auf main gibt: die Datei laeuft fuer die
 * Gegenprobe unveraendert gegen den Stand vor Schritt 4.
 *
 * Das Skript faehrt die Datei unter TZ=UTC und TZ=America/Chicago.
 * Ausfuehren: npm run test:occurrence-key-writes
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const db = (await import('../server/db.js')).get();
const { expandAndResolveEventRows } = await import('../server/services/calendar-event-reader.js');
const {
  deleteOccurrence, splitSeries, truncateSeries, upsertOccurrenceOverride,
} = await import('../server/services/calendar-occurrence-overrides.js');
const { getCountdowns } = await import('../server/services/countdowns.js');
const { buildFeed } = await import('../server/services/ics-export.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'admin', 'Admin', 'x', 'admin')").run();

function setHousehold(zone) {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
}

beforeEach(() => {
  db.prepare('DELETE FROM calendar_events').run();
  setHousehold('Europe/Berlin');
});

function insertSeries({ title, start, end = null, tzid = null, rule, countdown = 0 }) {
  return Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, tzid, recurrence_rule,
       created_by, color, icon, visibility, countdown)
    VALUES (?, ?, ?, 0, ?, ?, 1, '#007AFF', 'calendar', 'all', ?)
  `).run(title, start, end, tzid, rule, countdown).lastInsertRowid);
}

function rows() {
  return db.prepare('SELECT * FROM calendar_events').all();
}

/** Der Lesepfad wie GET /calendar, Fenster in Haushaltstagen. */
function read(from, to) {
  return expandAndResolveEventRows(db, rows(), from, to);
}

/** Tag eines Zeitpunkts in einer Zone, eigene Intl-Rechnung. */
function dayIn(iso, zone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

/** Der Schluessel, den der Kalender fuer das Vorkommen am Ortstag `day` ausgibt. */
function keyShownOn(seriesId, zone, day) {
  const hits = read(shiftDay(day, -2), shiftDay(day, 2))
    .filter((event) => Number(event.series_id ?? event.id) === seriesId
      && !event.is_occurrence_override
      && dayIn(event.start_datetime, zone) === day);
  assert.equal(hits.length, 1, `genau ein Vorkommen am ${day} in ${zone}`);
  return hits[0].recurrence_identity ?? hits[0].recurrence_id;
}

function shiftDay(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function startsOf(seriesIds, from, to) {
  const ids = new Set(seriesIds.map(Number));
  return read(from, to)
    .filter((event) => ids.has(Number(event.series_id ?? event.id)))
    .map((event) => event.start_datetime)
    .sort();
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; next(); });
  app.use('/', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

// Europe/Berlin taeglich 01:30, Start im Sommer 2034. Im Maerz 2035: 01:30 MEZ
// = 00:30Z bis einschliesslich 25.03. (Umstellung um 02:00), danach 23:30Z
// des Vortags. Im Oktober: bis 28.10. 23:30Z des Vortags, ab 29.10. 00:30Z.
const BERLIN_NIGHT = { title: 'Nacht', start: '2034-06-30T23:30:00Z', end: '2034-07-01T00:30:00Z', tzid: 'Europe/Berlin', rule: 'FREQ=DAILY' };

test('Berlin 01:30: "nur dieser" am 25.03.2035 loescht genau ein Vorkommen', () => {
  const id = insertSeries(BERLIN_NIGHT);
  deleteOccurrence(db, { seriesId: id, recurrenceId: keyShownOn(id, 'Europe/Berlin', '2035-03-25'), actorId: 1 });
  assert.deepEqual(startsOf([id], '2035-03-23', '2035-03-27'), [
    '2035-03-23T00:30:00Z', '2035-03-24T00:30:00Z', '2035-03-25T23:30:00Z', '2035-03-26T23:30:00Z',
  ]);
});

test('Berlin 01:30: "nur dieser" am 28.10.2035 loescht genau ein Vorkommen', () => {
  const id = insertSeries(BERLIN_NIGHT);
  deleteOccurrence(db, { seriesId: id, recurrenceId: keyShownOn(id, 'Europe/Berlin', '2035-10-28'), actorId: 1 });
  assert.deepEqual(startsOf([id], '2035-10-26', '2035-10-30'), [
    '2035-10-25T23:30:00Z', '2035-10-26T23:30:00Z', '2035-10-29T00:30:00Z', '2035-10-30T00:30:00Z',
  ]);
});

// Los Angeles montags 23:30 = dienstags 06:30Z.
const LA_LATE = { title: 'LA', start: '2035-06-12T06:30:00Z', end: '2035-06-12T07:30:00Z', tzid: 'America/Los_Angeles', rule: 'FREQ=WEEKLY;BYDAY=MO' };

test('Los Angeles 23:30: "dieser und folgende" loeschen kuerzt auf den LA-Vortag', () => {
  const id = insertSeries(LA_LATE);
  const result = truncateSeries(db, { seriesId: id, recurrenceId: keyShownOn(id, 'America/Los_Angeles', '2035-06-18'), actorId: 1 });
  assert.equal(result.recurrenceRule, 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20350617');
  assert.deepEqual(startsOf([id], '2035-06-10', '2035-07-10'), ['2035-06-12T06:30:00Z']);
});

test('Los Angeles 23:30: "dieser und folgende" bearbeiten zeigt das Vorkommen genau einmal', () => {
  const id = insertSeries(LA_LATE);
  const split = splitSeries(db, {
    seriesId: id,
    recurrenceId: keyShownOn(id, 'America/Los_Angeles', '2035-06-18'),
    actorId: 1,
    changes: { title: 'LA neu' },
  });
  const successorId = Number(split.series.id);
  const starts = startsOf([id, successorId], '2035-06-10', '2035-07-05');
  assert.deepEqual(starts, [
    '2035-06-12T06:30:00Z', '2035-06-19T06:30:00Z', '2035-06-26T06:30:00Z', '2035-07-03T06:30:00Z',
  ]);
  const chosen = read('2035-06-18', '2035-06-20').filter((event) => event.start_datetime === '2035-06-19T06:30:00Z');
  assert.deepEqual(chosen.map((event) => event.title), ['LA neu']);
});

test('COUNT oestlich von UTC: "dieser und folgende" zaehlt am Schleifentag weiter', () => {
  // Tokio 08:00 = 23:00Z des Vortags, zehn Vorkommen ab dem 07.01.2026 (Tokio).
  const id = insertSeries({
    title: 'Tokio', start: '2026-01-06T23:00:00Z', end: '2026-01-07T00:00:00Z',
    tzid: 'Asia/Tokyo', rule: 'FREQ=DAILY;COUNT=10',
  });
  const split = splitSeries(db, {
    seriesId: id,
    recurrenceId: keyShownOn(id, 'Asia/Tokyo', '2026-01-09'),
    actorId: 1,
    changes: { title: 'Tokio neu' },
  });
  const successor = db.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?').get(split.series.id);
  assert.equal(successor.recurrence_rule, 'FREQ=DAILY;COUNT=8');
  const starts = startsOf([id, Number(split.series.id)], '2026-01-01', '2026-01-31');
  assert.equal(starts.length, 10);
  assert.equal(new Set(starts).size, 10, 'kein Vorkommen doppelt');
});

test('Altform als Eingabe: ein Treffer 200, in der Umstellungsnacht 409 ambiguous_recurrence_id', async () => {
  const id = insertSeries(BERLIN_NIGHT);
  const { base, close } = await startApp(calendarRouter);
  try {
    // `2035-03-25` meinte auf main das Vorkommen vom 26.03. 01:30 (23:30Z des 25.).
    const one = await fetch(`${base}/${id}/occurrences/2035-03-25`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Eins' }),
    });
    assert.equal(one.status, 200);
    assert.equal((await one.json()).data.start_datetime, '2035-03-25T23:30:00Z');
    // `2035-03-24` meinte zwei Vorkommen.
    for (const method of ['PUT', 'DELETE']) {
      const two = await fetch(`${base}/${id}/occurrences/2035-03-24`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Zwei' }),
      });
      assert.equal(two.status, 409, method);
      assert.equal((await two.json()).reason, 'ambiguous_recurrence_id', method);
    }
    assert.deepEqual(db.prepare(
      'SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ? ORDER BY exception_date',
    ).all(id).map((row) => row.exception_date), ['2035-03-25T23:30:00Z']);
  } finally { await close(); }
});

test('Countdown: Serie aus Los Angeles im Berliner Haushalt, mit Absage (#1998)', () => {
  // Montags 23:30 in LA = dienstags 08:30 in Berlin. Heute ist Dienstag, der 19.06.
  const id = insertSeries({ ...LA_LATE, start: '2035-06-05T06:30:00Z', end: '2035-06-05T07:30:00Z', countdown: 1 });
  const next = () => getCountdowns(db, { userId: 1, todayKey: '2035-06-19' }).items
    .find((item) => item.id === id)?.date ?? null;
  assert.equal(next(), '2035-06-19', 'das heutige Vorkommen (LA-Montag)');
  // Die Absage in der Form, die main fuer genau dieses Vorkommen schrieb (UTC-Tag).
  db.prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)').run(id, '2035-06-19');
  assert.equal(next(), '2035-06-26', 'naechster Dienstag in Berlin, nicht der Montag');
});

test('ICS-Feed: ein exakter Schluessel geht als RFC-Originalstart hinaus', () => {
  const id = insertSeries(BERLIN_NIGHT);
  deleteOccurrence(db, { seriesId: id, recurrenceId: keyShownOn(id, 'Europe/Berlin', '2035-03-25'), actorId: 1 });
  upsertOccurrenceOverride(db, {
    seriesId: id, recurrenceId: keyShownOn(id, 'Europe/Berlin', '2035-03-26'), actorId: 1, changes: { title: 'Eigener Titel' },
  });
  const local = insertSeries({ title: 'Lokal', start: '2035-03-20T09:00', end: '2035-03-20T10:00', rule: 'FREQ=DAILY' });
  deleteOccurrence(db, { seriesId: local, recurrenceId: keyShownOn(local, 'Europe/Berlin', '2035-03-22'), actorId: 1 });
  const lines = buildFeed(db, 1, new Date('2035-03-01T12:00:00Z'), 'Europe/Berlin').replace(/\r\n /g, '').split(/\r?\n/);
  // Genau die eine Nacht, nicht auch die vorige; das Einzelvorkommen als
  // RECURRENCE-ID desselben Slots und ohne EXDATE daneben.
  assert.ok(lines.includes('EXDATE;TZID=Europe/Berlin:20350325T013000'));
  assert.ok(!lines.includes('EXDATE;TZID=Europe/Berlin:20350324T013000'));
  assert.ok(lines.includes('RECURRENCE-ID;TZID=Europe/Berlin:20350326T013000'));
  assert.ok(!lines.includes('EXDATE;TZID=Europe/Berlin:20350326T013000'));
  // Schwebende Wanduhr einer lokalen Serie: in der Feed-Zone verankert (#818).
  assert.ok(lines.includes('EXDATE;TZID=Europe/Berlin:20350322T090000'));
});

// Die folgenden Faelle waren auf main gruen: dort trug der Schluessel
// keine Uhrzeit, und eine neue Startzeit liess ihn stehen. Mit Format A muss
// er mitwandern (Auflage 2) - sie halten das Umschluesseln fest.
test('Neue Startzeit der Serie: Ausnahme und Einzelvorkommen wandern mit (PUT /:id)', async () => {
  const id = insertSeries({ title: 'Lokal', start: '2035-05-01T09:00', end: '2035-05-01T10:00', rule: 'FREQ=DAILY' });
  deleteOccurrence(db, { seriesId: id, recurrenceId: keyShownOn(id, 'Europe/Berlin', '2035-05-03'), actorId: 1 });
  upsertOccurrenceOverride(db, {
    seriesId: id, recurrenceId: keyShownOn(id, 'Europe/Berlin', '2035-05-04'), actorId: 1, changes: { title: 'Eigener Titel' },
  });
  const { base, close } = await startApp(calendarRouter);
  try {
    const res = await fetch(`${base}/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_datetime: '2035-05-01T10:30', end_datetime: '2035-05-01T11:30' }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  } finally { await close(); }
  const events = read('2035-05-02', '2035-05-05')
    .filter((event) => Number(event.series_id ?? event.id) === id)
    .map((event) => [event.start_datetime, event.title]);
  assert.deepEqual(events, [
    ['2035-05-02T10:30', 'Lokal'], ['2035-05-04T10:30', 'Eigener Titel'], ['2035-05-05T10:30', 'Lokal'],
  ]);
});

test('"Dieser und folgende" mit neuer Uhrzeit: spaetere Ausnahme und Einzelvorkommen wandern zur Folgeserie', () => {
  const id = insertSeries({ title: 'Lokal', start: '2035-05-01T09:00', end: '2035-05-01T10:00', rule: 'FREQ=DAILY' });
  deleteOccurrence(db, { seriesId: id, recurrenceId: keyShownOn(id, 'Europe/Berlin', '2035-05-05'), actorId: 1 });
  upsertOccurrenceOverride(db, {
    seriesId: id, recurrenceId: keyShownOn(id, 'Europe/Berlin', '2035-05-06'), actorId: 1, changes: { title: 'Eigener Titel' },
  });
  const split = splitSeries(db, {
    seriesId: id,
    recurrenceId: keyShownOn(id, 'Europe/Berlin', '2035-05-03'),
    actorId: 1,
    changes: { start_datetime: '2035-05-03T11:00', end_datetime: '2035-05-03T12:00' },
  });
  const successorId = Number(split.series.id);
  const events = read('2035-05-01', '2035-05-07')
    .filter((event) => [id, successorId].includes(Number(event.series_id ?? event.id)))
    .map((event) => [event.start_datetime, event.title])
    .sort();
  assert.deepEqual(events, [
    ['2035-05-01T09:00', 'Lokal'], ['2035-05-02T09:00', 'Lokal'],
    ['2035-05-03T11:00', 'Lokal'], ['2035-05-04T11:00', 'Lokal'],
    ['2035-05-06T11:00', 'Eigener Titel'], ['2035-05-07T11:00', 'Lokal'],
  ]);
  assert.deepEqual(db.prepare(
    'SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ? ORDER BY exception_date',
  ).all(successorId).map((row) => row.exception_date), ['2035-05-05T11:00:00', '2035-05-06T11:00:00']);
});

test('Neue Startzeit einer Serie ohne Einzelvorkommen-Recht: die Ausnahme wandert mit', async () => {
  // Ein Ausgangsziel nimmt der Serie die verknuepften Einzelvorkommen; PUT
  // laeuft dann ohne `updateSeriesWithOverrides`.
  const id = insertSeries({ title: 'Mit Ziel', start: '2035-05-01T09:00', end: '2035-05-01T10:00', rule: 'FREQ=DAILY' });
  db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'family@test' WHERE id = ?").run(id);
  const { base, close } = await startApp(calendarRouter);
  try {
    const exception = await fetch(`${base}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recurrence_id: keyShownOn(id, 'Europe/Berlin', '2035-05-03') }),
    });
    assert.equal(exception.status, 201);
    const res = await fetch(`${base}/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_datetime: '2035-05-01T10:30', end_datetime: '2035-05-01T11:30' }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  } finally { await close(); }
  assert.deepEqual(startsOf([id], '2035-05-02', '2035-05-04'), ['2035-05-02T10:30', '2035-05-04T10:30']);
});

test('Wechsel der Haushaltszone schluesselt eine #1993-Serie mit um (F5)', async () => {
  // New-York-Serie, deren Start als Wanduhr des Haushalts gespeichert ist.
  const id = insertSeries({ title: '1993', start: '2035-03-20T21:30', end: '2035-03-20T22:30', tzid: 'America/New_York', rule: 'FREQ=DAILY' });
  // Haushalt Berlin: 21:30 Berlin = 20:30Z = 16:30 New York.
  deleteOccurrence(db, { seriesId: id, recurrenceId: keyShownOn(id, 'America/New_York', '2035-03-25'), actorId: 1 });
  upsertOccurrenceOverride(db, {
    seriesId: id, recurrenceId: keyShownOn(id, 'America/New_York', '2035-03-26'), actorId: 1, changes: { title: 'Eigener Titel' },
  });

  const { base, close } = await startApp(preferencesRouter);
  try {
    const res = await fetch(`${base}/`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: 'America/New_York' }),
    });
    assert.equal(res.status, 200);
  } finally { await close(); }

  // Haushalt New York: 21:30 New York = 01:30Z des Folgetags.
  const events = read('2035-03-23', '2035-03-27')
    .filter((event) => Number(event.series_id ?? event.id) === id)
    .map((event) => [dayIn(event.start_datetime, 'America/New_York'), event.title])
    .sort();
  assert.deepEqual(events, [
    ['2035-03-23', '1993'], ['2035-03-24', '1993'], ['2035-03-26', 'Eigener Titel'], ['2035-03-27', '1993'],
  ]);
});
