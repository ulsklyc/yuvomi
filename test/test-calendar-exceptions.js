/**
 * Test: Einzeltermin-Ausnahmen für Serien (EXDATE, #489)
 * Zweck: Migration v85 (calendar_event_exceptions) + POST /calendar/:id/exceptions
 *        + Filterung in GET /calendar (expandRecurringEvents). Prüft: Ausnahme
 *        blendet genau eine Instanz aus, andere bleiben; nicht-wiederkehrend → 400;
 *        externe Serie → 400; Serien-Löschung entfernt Ausnahmen (CASCADE).
 * Ausführen: node --experimental-sqlite --test test/test-calendar-exceptions.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const db = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

// Geteilte :memory:-DB (Singleton) → Events zwischen Tests zurücksetzen.
// Ausnahmen verschwinden per ON DELETE CASCADE mit ihren Events.
beforeEach(() => {
  db.get().prepare('DELETE FROM calendar_events').run();
});

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; next(); });
  app.use('/', calendarRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

function seedUser() {
  db.get().prepare(
    `INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role)
     VALUES (1, 'admin', 'Admin', 'x', 'admin')`
  ).run();
}

// Weekly-Gym-Serie ab Dienstag, 14.07.2026 (lokale, naive Zeit).
// external_source ist NOT NULL DEFAULT 'local' → für lokale Events weglassen.
function seedWeeklyEvent({ external = null } = {}) {
  if (external) {
    return db.get().prepare(
      `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, external_source, created_by)
       VALUES ('Gym', '2026-07-14T18:00', '2026-07-14T19:00', 0, 'FREQ=WEEKLY;BYDAY=TU', ?, 1)`
    ).run(external).lastInsertRowid;
  }
  return db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, created_by)
     VALUES ('Gym', '2026-07-14T18:00', '2026-07-14T19:00', 0, 'FREQ=WEEKLY;BYDAY=TU', 1)`
  ).run().lastInsertRowid;
}

const RANGE = '?from=2026-07-14&to=2026-07-28';

test('POST exceptions: single occurrence removed from GET, others remain', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    const before = await (await fetch(`${baseUrl}/${RANGE}`)).json();
    const beforeDates = before.data.map((e) => e.start_datetime);
    assert.deepEqual(beforeDates, ['2026-07-14T18:00', '2026-07-21T18:00', '2026-07-28T18:00']);

    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-21' }),
    });
    assert.equal(post.status, 201);

    const after = await (await fetch(`${baseUrl}/${RANGE}`)).json();
    const afterDates = after.data.map((e) => e.start_datetime);
    assert.deepEqual(afterDates, ['2026-07-14T18:00', '2026-07-28T18:00'], 'nur die ausgenommene Instanz fehlt');
  } finally { await close(); }
});

test('POST exceptions: master start date can be excluded, series continues', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-14' }),
    });
    assert.equal(post.status, 201);
    const after = await (await fetch(`${baseUrl}/${RANGE}`)).json();
    const dates = after.data.map((e) => e.start_datetime);
    assert.deepEqual(dates, ['2026-07-21T18:00', '2026-07-28T18:00']);
  } finally { await close(); }
});

test('POST exceptions: 400 for non-recurring event', async () => {
  seedUser();
  const id = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('Einmalig', '2026-07-14T18:00', 1)`
  ).run().lastInsertRowid;
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-14' }),
    });
    assert.equal(post.status, 400);
  } finally { await close(); }
});

test('POST exceptions: 400 for externally synced series', async () => {
  seedUser();
  const id = seedWeeklyEvent({ external: 'google' });
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-21' }),
    });
    assert.equal(post.status, 400);
  } finally { await close(); }
});

test('POST exceptions: 400 for invalid date', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '14.07.2026' }),
    });
    assert.equal(post.status, 400);
  } finally { await close(); }
});

test('DELETE series removes its exceptions (ON DELETE CASCADE)', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-21' }),
    });
    const countBefore = db.get().prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id = ?').get(id).n;
    assert.equal(countBefore, 1);

    const del = await fetch(`${baseUrl}/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const countAfter = db.get().prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id = ?').get(id).n;
    assert.equal(countAfter, 0, 'Ausnahmen der gelöschten Serie sind mitentfernt');
  } finally { await close(); }
});

// --------------------------------------------------------
// #2000: EIN Schluessel fuer "dieses Vorkommen" - der UTC-Tag, auch ueber eine
// Zeitumstellung. Feste Kalendertage, keine Uhr; die Suite laeuft unter
// TZ=UTC und TZ=America/Chicago (package.json), die Prozesszone darf nichts
// aendern.
// --------------------------------------------------------

const { expandRecurringEvents, loadEventExceptions } = await import('../server/services/calendar-events.js');
const { MIGRATIONS } = db;

function setHouseholdZone(zone) {
  db.get().prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(zone);
}

/** Die Starts einer Serie im Fenster, mit den Ausnahmen aus der Datenbank. */
function startsOf(id, from, to) {
  const row = db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  return expandRecurringEvents([row], from, to, loadEventExceptions(db.get(), [id]), {
    householdZone: db.get().prepare("SELECT value FROM sync_config WHERE key = 'household_timezone'").get()?.value,
  }).map((occurrence) => occurrence.start_datetime);
}

// New York 19:30, woechentlich ab Montag, 1. Oktober 2035: im Oktober 23:30Z
// am selben Tag, nach dem 4. November 00:30Z am Folgetag. So legt CalDAV die
// Serie ab (Start als UTC, Zone daneben).
function seedNewYorkEvening(external = 'caldav') {
  return db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, external_source, created_by)
     VALUES ('Chor', '2035-10-01T23:30:00Z', '2035-10-02T00:30:00Z', 0, 'FREQ=WEEKLY', 'America/New_York', ?, 1)`
  ).run(external).lastInsertRowid;
}

function addException(id, date) {
  db.get().prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)').run(id, date);
}

test('#2000: EXDATE nach der Zeitumstellung blendet genau dieses Vorkommen aus', () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const id = seedNewYorkEvening();
  // Der Import legt das Vorkommen vom 12. November (19:30 EST) unter seinem
  // UTC-Tag ab, dem 13. (ics-parser.js: formatICSDate(...).slice(0, 10)).
  addException(id, '2035-11-13');
  assert.deepEqual(startsOf(id, '2035-11-05', '2035-11-25'), [
    '2035-11-06T00:30:00Z',
    '2035-11-20T00:30:00Z',
  ], 'der abgesagte 12. November darf nicht erscheinen, die Nachbarn bleiben');
});

test('#2000: EXDATE vor der Zeitumstellung blendet genau dieses Vorkommen aus', () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const id = seedNewYorkEvening();
  // 15. Oktober 19:30 EDT = 23:30Z am selben Tag.
  addException(id, '2035-10-15');
  assert.deepEqual(startsOf(id, '2035-10-07', '2035-10-25'), [
    '2035-10-08T23:30:00Z',
    '2035-10-22T23:30:00Z',
  ]);
});

test('#2000: der lokale Tag als EXDATE trifft nach der Umstellung kein Vorkommen', () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const id = seedNewYorkEvening();
  // Gegenprobe zur Richtung: der 12. ist nicht der Schluessel des Vorkommens
  // vom 12. November, sonst gaelte je nach Pfad mal der eine, mal der andere.
  addException(id, '2035-11-12');
  assert.deepEqual(startsOf(id, '2035-11-05', '2035-11-25'), [
    '2035-11-06T00:30:00Z',
    '2035-11-13T00:30:00Z',
    '2035-11-20T00:30:00Z',
  ]);
});

test('#2000: Berlin 01:30 ueber die Maerz-Umstellung - EXDATE vor und nach dem Wechsel', () => {
  seedUser();
  setHouseholdZone('Europe/Berlin');
  // 01:30 MEZ = 00:30Z am selben Tag; ab dem 25. Maerz 2035 ist 01:30 MESZ
  // 23:30Z am VORTAG.
  const id = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, external_source, created_by)
     VALUES ('Nacht', '2035-03-05T00:30:00Z', '2035-03-05T01:00:00Z', 0, 'FREQ=WEEKLY', 'Europe/Berlin', 'apple', 1)`
  ).run().lastInsertRowid;
  addException(id, '2035-03-12'); // vor dem Wechsel: Montag 12.03. 01:30 MEZ
  addException(id, '2035-04-01'); // nach dem Wechsel: Montag 02.04. 01:30 MESZ = 01.04. 23:30Z
  assert.deepEqual(startsOf(id, '2035-03-04', '2035-04-10'), [
    '2035-03-05T00:30:00Z',
    '2035-03-19T00:30:00Z',
    '2035-03-25T23:30:00Z',
    '2035-04-08T23:30:00Z',
  ]);
});

test('#2000: die Kennung eines Vorkommens ist sein UTC-Tag, auch fuer einen Start mit Offset', () => {
  // Google speichert den Start mit dem Offset der Serienzone; seine ersten
  // zehn Zeichen sind der lokale Tag.
  const google = {
    id: 9, start_datetime: '2035-11-05T19:30:00-05:00', end_datetime: '2035-11-05T20:30:00-05:00',
    all_day: 0, recurrence_rule: 'FREQ=WEEKLY', tzid: 'America/New_York',
  };
  const rows = expandRecurringEvents([google], '2035-11-04', '2035-11-14', null, { includeRecurrenceIdentity: true });
  assert.deepEqual(rows.map((r) => [r.start_datetime, r.recurrence_identity, r.is_recurring_instance]), [
    ['2035-11-06T00:30:00Z', '2035-11-06', 0],
    ['2035-11-13T00:30:00Z', '2035-11-13', 1],
  ]);
});

test('#2000: GET /calendar zeigt das abgesagte Vorkommen nicht', async () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const id = seedNewYorkEvening();
  addException(id, '2035-11-13');
  const { baseUrl, close } = await startApp();
  try {
    const body = await (await fetch(`${baseUrl}/?from=2035-11-05&to=2035-11-25`)).json();
    assert.deepEqual(body.data.filter((e) => e.id === id).map((e) => e.start_datetime), [
      '2035-11-06T00:30:00Z',
      '2035-11-20T00:30:00Z',
    ]);
  } finally { await close(); }
});

test('#2000: Migration 250 rechnet per Regel um und loescht nichts', () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const migration = MIGRATIONS.find((m) => m.version === 250);
  assert.ok(migration, 'Migration 250 fehlt');
  const exceptions = (id) => db.get().prepare(
    'SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ? ORDER BY exception_date'
  ).all(id).map((r) => r.exception_date);
  db.get().prepare(`INSERT INTO google_calendar_selection (calendar_id, name, enabled, sync_token, last_sync)
    VALUES ('g2000', 'G', 1, 'tok-2000', '2035-11-01T00:00:00Z')
    ON CONFLICT(calendar_id) DO UPDATE SET sync_token = excluded.sync_token, last_sync = excluded.last_sync`).run();
  const googleSeries = (rule, { dirty = 0 } = {}) => db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid,
       external_source, external_calendar_id, outbound_dirty, created_by)
     VALUES ('G', '2035-10-01T19:30:00-04:00', '2035-10-01T20:30:00-04:00', 0, ?, 'America/New_York',
       'google', ?, ?, 1)`
  ).run(rule, `g-${rule}-${dirty}`, dirty).lastInsertRowid;

  // Google, woechentlich montags 19:30 New York.
  const weekly = googleSeries('RRULE:FREQ=WEEKLY');
  addException(weekly, '2035-10-15'); // EDT, lokal = UTC: bleibt
  addException(weekly, '2035-11-19'); // lokal (Montag, originalStartTime mit Offset) -> 20.
  addException(weekly, '2035-11-13'); // schon UTC (EXDATE:20351113T003000Z, Dienstag): bleibt
  addException(weekly, '2036-11-03'); // mehr als ein Jahr spaeter, lokal -> 04.
  // Ein Master, dessen lokale Aenderung noch auf den Push wartet: umgerechnet
  // wie jeder andere, nichts geht verloren.
  const dirty = googleSeries('RRULE:FREQ=WEEKLY', { dirty: 1 });
  addException(dirty, '2035-11-12');
  // Taeglich: `2035-11-12` ist der lokale Tag des Vorkommens vom 12. UND der
  // UTC-Tag des Vorkommens vom 11. - nicht zu entscheiden, bleibt (#2034).
  const daily = googleSeries('RRULE:FREQ=DAILY');
  addException(daily, '2035-11-12');
  // Eine ganztaegige Google-Serie hat nur Tage als Schluessel - sie bleibt.
  const googleAllDay = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, external_source, external_calendar_id, created_by)
     VALUES ('GT', '2035-10-01', '2035-10-01', 1, 'FREQ=WEEKLY', 'google', 'g2', 1)`
  ).run().lastInsertRowid;
  addException(googleAllDay, '2035-11-12');

  // Hier gefuehrt, zonenlose Ziffern neben der tzid (#1993); die Kennung kam
  // nur aus der Oberflaeche und war sicher lokal.
  const local = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, created_by)
     VALUES ('L', '2035-10-01T19:30', '2035-10-01T20:30', 0, 'FREQ=DAILY', 'America/New_York', 1)`
  ).run().lastInsertRowid;
  addException(local, '2035-10-15'); // EDT: derselbe UTC-Tag
  addException(local, '2035-11-12'); // EST: der 13.
  addException(local, '2035-11-13'); // EST: der 14. - taeglich, die beiden verdraengen sich
  const child = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_parent_id, recurrence_id, created_by)
     VALUES ('L*', '2035-11-19T21:00', '2035-11-19T22:00', 0, ?, '2035-11-19', 1)`
  ).run(local).lastInsertRowid;
  const nextChild = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_parent_id, recurrence_id, created_by)
     VALUES ('L**', '2035-11-20T21:00', '2035-11-20T22:00', 0, ?, '2035-11-20', 1)`
  ).run(local).lastInsertRowid;

  // CalDAV: schon immer der UTC-Tag - bleibt.
  const caldav = seedNewYorkEvening();
  addException(caldav, '2035-11-13');

  migration.up(db.get());

  assert.deepEqual(exceptions(weekly), ['2035-10-15', '2035-11-13', '2035-11-20', '2036-11-04']);
  assert.deepEqual(exceptions(dirty), ['2035-11-13']);
  assert.deepEqual(exceptions(daily), ['2035-11-12'], 'mehrdeutig: bleibt stehen');
  assert.deepEqual(exceptions(googleAllDay), ['2035-11-12']);
  assert.equal(
    db.get().prepare("SELECT sync_token FROM google_calendar_selection WHERE calendar_id = 'g2000'").get().sync_token,
    'tok-2000', 'kein erzwungener Neuabruf');
  assert.deepEqual(exceptions(local), ['2035-10-15', '2035-11-13', '2035-11-14']);
  const childKey = (id) => db.get().prepare('SELECT recurrence_id FROM calendar_events WHERE id = ?').get(id).recurrence_id;
  assert.equal(childKey(child), '2035-11-20');
  assert.equal(childKey(nextChild), '2035-11-21');
  assert.deepEqual(exceptions(caldav), ['2035-11-13']);

  // Und die Expansion trifft danach die gemeinten Vorkommen.
  const weeklyStarts = startsOf(weekly, '2035-11-10', '2035-11-25');
  assert.ok(!weeklyStarts.includes('2035-11-13T00:30:00Z'), 'Google: der 12. November bleibt abgesagt (UTC-Schluessel)');
  assert.ok(!weeklyStarts.includes('2035-11-20T00:30:00Z'), 'Google: der 19. November bleibt abgesagt (umgerechnet)');
  const localStarts = startsOf(local, '2035-11-10', '2035-11-16');
  assert.ok(!localStarts.includes('2035-11-13T00:30:00Z'), 'der 12. November bleibt abgesagt');
  assert.ok(!localStarts.includes('2035-11-14T00:30:00Z'), 'der 13. November bleibt abgesagt');
  assert.ok(localStarts.includes('2035-11-12T00:30:00Z'), 'der 11. November bleibt stehen');
});

const { occurrenceKeyOnDay } = await import('../server/services/calendar-events.js');
const { utcToWall } = await import('../server/utils/timezone.js');

test('#2000: occurrenceKeyOnDay liefert denselben Schluessel wie die Expansion, ueber beide Umstellungen', () => {
  const series = [
    { id: 1, start_datetime: '2035-10-01T23:30:00Z', all_day: 0, recurrence_rule: 'FREQ=DAILY', tzid: 'America/New_York' },
    { id: 2, start_datetime: '2035-10-01T19:30:00-04:00', all_day: 0, recurrence_rule: 'FREQ=WEEKLY', tzid: 'America/New_York' },
    { id: 3, start_datetime: '2035-03-01T00:30:00Z', all_day: 0, recurrence_rule: 'FREQ=DAILY', tzid: 'Europe/Berlin' },
    { id: 4, start_datetime: '2035-10-01T23:30:00Z', all_day: 0, recurrence_rule: 'FREQ=DAILY', tzid: null },
  ];
  const windows = {
    1: ['2035-10-25', '2035-11-15'], 2: ['2035-10-25', '2035-11-30'],
    3: ['2035-03-15', '2035-04-05'], 4: ['2035-10-25', '2035-11-15'],
  };
  let checked = 0;
  for (const event of series) {
    const [from, to] = windows[event.id];
    const occurrences = expandRecurringEvents([event], from, to, null, { includeRecurrenceIdentity: true });
    for (const zone of [event.tzid ?? 'UTC', 'UTC', 'America/Chicago']) {
      const days = occurrences.map((o) => utcToWall(o.start_datetime, zone).date);
      occurrences.forEach((occurrence, i) => {
        // Zwei Vorkommen am selben Tag (Fruehjahrsnacht) haben keinen
        // eindeutigen Tag - die bleiben der Folgeaufgabe #2034.
        if (days.indexOf(days[i]) !== days.lastIndexOf(days[i])) return;
        assert.equal(occurrenceKeyOnDay(event, days[i], zone), occurrence.recurrence_identity,
          `Serie ${event.id}, ${occurrence.start_datetime} in ${zone}`);
        checked++;
      });
    }
  }
  assert.ok(checked > 100, `zu wenig geprueft: ${checked}`);
});
