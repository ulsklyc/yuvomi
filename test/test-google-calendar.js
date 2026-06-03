/**
 * Modul: Google Calendar Sync – Unit-Tests
 * Zweck: Validiert die Hilfsfunktionen für die Datumskonvertierung (RFC 5545
 *        exklusive Enddaten) und das RRULE-Präfix beim Outbound-Sync.
 * Ausführen: node test/test-google-calendar.js
 */

// In-Memory-DB für die DB-gestützten Tests (upsertGoogleEvents).
// Muss VOR dem Import von google-calendar.js gesetzt werden, da db.js beim
// Import init() ausführt und sich mit DB_PATH verbindet.
process.env.DB_PATH = ':memory:';

const db = (await import('../server/db.js')).get();
const { __test } = await import('../server/services/google-calendar.js');
const { localEventToGoogle, googleAllDayEndToInclusive, localAllDayEndToExclusive,
        upsertGoogleEvents, upsertExternalCalendar, getCalendarId, setCalendarId } = __test;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\n[Google Calendar Test] Datumskonvertierung + RRULE-Präfix\n');

// --------------------------------------------------------
// googleAllDayEndToInclusive – Google exklusiv → Oikos inklusiv
// --------------------------------------------------------
test('googleAllDayEndToInclusive: 2-Tage-Event (Jan 1–2)', () => {
  assertEqual(googleAllDayEndToInclusive('2026-01-03'), '2026-01-02');
});

test('googleAllDayEndToInclusive: 1-Tage-Event (Jan 1)', () => {
  assertEqual(googleAllDayEndToInclusive('2026-01-02'), '2026-01-01');
});

test('googleAllDayEndToInclusive: Monatsgrenze (Feb 28 → Feb 27)', () => {
  assertEqual(googleAllDayEndToInclusive('2026-03-01'), '2026-02-28');
});

test('googleAllDayEndToInclusive: null → null', () => {
  assertEqual(googleAllDayEndToInclusive(null), null);
});

// --------------------------------------------------------
// localAllDayEndToExclusive – Oikos inklusiv → Google exklusiv
// --------------------------------------------------------
test('localAllDayEndToExclusive: Jan 2 → Jan 3', () => {
  assertEqual(localAllDayEndToExclusive('2026-01-02'), '2026-01-03');
});

test('localAllDayEndToExclusive: Jahresgrenze (Dec 31 → Jan 1)', () => {
  assertEqual(localAllDayEndToExclusive('2026-12-31'), '2027-01-01');
});

test('localAllDayEndToExclusive: null → null', () => {
  assertEqual(localAllDayEndToExclusive(null), null);
});

test('Roundtrip: inklusiv → exklusiv → inklusiv', () => {
  const inclusive = '2026-06-15';
  const exclusive = localAllDayEndToExclusive(inclusive);
  assertEqual(googleAllDayEndToInclusive(exclusive), inclusive);
});

// --------------------------------------------------------
// localEventToGoogle – Ganztätige Events
// --------------------------------------------------------
test('localEventToGoogle: all-day end date wird um 1 Tag erhöht (exklusiv)', () => {
  const event = {
    title: 'Urlaub',
    all_day: 1,
    start_datetime: '2026-06-01',
    end_datetime:   '2026-06-07',
    recurrence_rule: null,
  };
  const g = localEventToGoogle(event);
  assertEqual(g.start.date, '2026-06-01', 'start.date korrekt');
  assertEqual(g.end.date,   '2026-06-08', 'end.date muss +1 Tag sein (exklusiv)');
});

test('localEventToGoogle: all-day single-day (kein end_datetime)', () => {
  const event = {
    title: 'Feiertag',
    all_day: 1,
    start_datetime: '2026-12-25',
    end_datetime:   null,
    recurrence_rule: null,
  };
  const g = localEventToGoogle(event);
  assertEqual(g.start.date, '2026-12-25');
  assertEqual(g.end.date,   '2026-12-26', 'Eintägiges Event: end = start + 1');
});

// --------------------------------------------------------
// localEventToGoogle – RRULE-Präfix
// --------------------------------------------------------
test('localEventToGoogle: RRULE-Präfix wird hinzugefügt (ohne Präfix)', () => {
  const event = {
    title: 'Wöchentlicher Termin',
    all_day: 0,
    start_datetime: '2026-06-01T10:00',
    end_datetime:   '2026-06-01T11:00',
    recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20260620T235959Z',
  };
  const g = localEventToGoogle(event);
  assert(Array.isArray(g.recurrence), 'recurrence ist Array');
  assertEqual(g.recurrence[0], 'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20260620T235959Z');
});

test('localEventToGoogle: RRULE-Präfix wird nicht doppelt hinzugefügt', () => {
  const event = {
    title: 'Import-Event',
    all_day: 0,
    start_datetime: '2026-06-01T10:00',
    end_datetime:   '2026-06-01T11:00',
    recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1',
  };
  const g = localEventToGoogle(event);
  assertEqual(g.recurrence[0], 'RRULE:FREQ=WEEKLY;INTERVAL=1', 'Kein doppeltes RRULE:');
});

test('localEventToGoogle: kein recurrence_rule → kein recurrence-Feld', () => {
  const event = {
    title: 'Einmalig',
    all_day: 0,
    start_datetime: '2026-06-01T10:00',
    end_datetime:   '2026-06-01T11:00',
    recurrence_rule: null,
  };
  const g = localEventToGoogle(event);
  assert(!g.recurrence, 'recurrence-Feld darf nicht vorhanden sein');
});

test('localEventToGoogle: all-day UNTIL wird auf reines DATE reduziert', () => {
  // Google/RFC 5545: Bei all-day-Events (start.date) muss UNTIL ein DATE
  // (YYYYMMDD) sein, kein DATE-TIME. buildRRule liefert immer DATE-TIME →
  // sonst "Invalid recurrence rule".
  const event = {
    title: 'Mehrtägig + Wiederholung',
    all_day: 1,
    start_datetime: '2026-06-01',
    end_datetime:   '2026-06-03',
    recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20260831T235959Z',
  };
  const g = localEventToGoogle(event);
  assertEqual(g.start.date,    '2026-06-01');
  assertEqual(g.end.date,      '2026-06-04', 'Mehrtägiges all-day end exklusiv');
  assertEqual(g.recurrence[0], 'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20260831');
});

// --------------------------------------------------------
// localEventToGoogle – RFC-3339-konforme dateTime (Sekunden)
// Regression: Issue #217 – Oikos speichert getimte Events als
// "YYYY-MM-DDTHH:MM" (ohne Sekunden). Google verlangt RFC 3339 mit
// Sekunden, sonst "Bad Request" bzw. (bei Wiederholung) "Invalid
// recurrence rule".
// --------------------------------------------------------
test('localEventToGoogle: getimtes Event bekommt Sekunden (RFC 3339)', () => {
  const event = {
    title: 'Meeting',
    all_day: 0,
    start_datetime: '2026-06-03T14:00',
    end_datetime:   '2026-06-03T15:00',
    recurrence_rule: null,
  };
  const g = localEventToGoogle(event);
  assertEqual(g.start.dateTime, '2026-06-03T14:00:00', 'start.dateTime mit Sekunden');
  assertEqual(g.end.dateTime,   '2026-06-03T15:00:00', 'end.dateTime mit Sekunden');
});

test('localEventToGoogle: getimtes Event ohne end → end = start mit Sekunden', () => {
  const event = {
    title: 'Termin',
    all_day: 0,
    start_datetime: '2026-06-03T14:00',
    end_datetime:   null,
    recurrence_rule: null,
  };
  const g = localEventToGoogle(event);
  assertEqual(g.start.dateTime, '2026-06-03T14:00:00');
  assertEqual(g.end.dateTime,   '2026-06-03T14:00:00');
});

test('localEventToGoogle: getimtes Wiederholungs-Event (Issue #217 Events 1/2)', () => {
  const event = {
    title: 'Yoga Class',
    all_day: 0,
    start_datetime: '2026-06-05T19:00',
    end_datetime:   '2026-06-05T20:00',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU',
  };
  const g = localEventToGoogle(event);
  assertEqual(g.start.dateTime, '2026-06-05T19:00:00', 'DTSTART mit Sekunden → gültige Recurrence');
  assertEqual(g.recurrence[0],  'RRULE:FREQ=WEEKLY;BYDAY=TU');
});

test('localEventToGoogle: bereits vorhandene Sekunden bleiben unverändert', () => {
  const event = {
    title: 'Importiert',
    all_day: 0,
    start_datetime: '2026-06-03T14:00:30',
    end_datetime:   '2026-06-03T15:00:00',
    recurrence_rule: null,
  };
  const g = localEventToGoogle(event);
  assertEqual(g.start.dateTime, '2026-06-03T14:00:30');
  assertEqual(g.end.dateTime,   '2026-06-03T15:00:00');
});

test('localEventToGoogle: getimtes UNTIL ohne Zeitteil wird zu UTC date-time', () => {
  const event = {
    title: 'Wöchentlich bis',
    all_day: 0,
    start_datetime: '2026-06-03T14:00',
    end_datetime:   '2026-06-03T15:00',
    recurrence_rule: 'FREQ=WEEKLY;UNTIL=20260831',
  };
  const g = localEventToGoogle(event);
  assertEqual(g.recurrence[0], 'RRULE:FREQ=WEEKLY;UNTIL=20260831T235959Z');
});

// --------------------------------------------------------
// upsertGoogleEvents – Event-Farben über Syncs erhalten (Issue #219)
// --------------------------------------------------------
console.log('\n[Google Calendar Test] upsertGoogleEvents – Farberhalt\n');

// Seed-User (created_by = 1 in upsertGoogleEvents)
db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();

const gEvent = {
  id: 'evt-color-219',
  status: 'confirmed',
  summary: 'Team-Meeting',
  start: { dateTime: '2026-06-03T10:00:00Z' },
  end:   { dateTime: '2026-06-03T11:00:00Z' },
};

test('Erst-Import setzt die Kalenderfarbe als Default', () => {
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([gEvent], calRefId, '#FF0000');
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.color, '#FF0000');
});

test('Re-Sync überschreibt benutzerdefinierte Event-Farbe NICHT', () => {
  // Nutzer ändert die Event-Farbe
  db.prepare('UPDATE calendar_events SET color = ? WHERE external_calendar_id = ?')
    .run('#00FF00', gEvent.id);
  // Erneuter Sync mit unveränderter Kalenderfarbe
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([gEvent], calRefId, '#FF0000');
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.color, '#00FF00', 'Benutzerfarbe muss über den Sync hinweg erhalten bleiben');
});

test('Re-Sync aktualisiert weiterhin die übrigen Felder', () => {
  const updated = { ...gEvent, summary: 'Team-Meeting (verschoben)' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([updated], calRefId, '#FF0000');
  const row = db.prepare(
    'SELECT title, color FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.title, 'Team-Meeting (verschoben)');
  assertEqual(row.color, '#00FF00', 'Farbe bleibt trotz Titeländerung erhalten');
});

// --------------------------------------------------------
// getCalendarId / setCalendarId – Kalenderauswahl (Issue #220)
// --------------------------------------------------------
console.log('\n[Google Calendar Test] Kalenderauswahl (Issue #220)\n');

function cfgGet(key) {
  const row = db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

test('getCalendarId: Default ist "primary", wenn nichts gesetzt ist', () => {
  db.prepare("DELETE FROM sync_config WHERE key = 'google_calendar_id'").run();
  assertEqual(getCalendarId(), 'primary');
});

test('setCalendarId: speichert die gewählte Kalender-ID', () => {
  setCalendarId('family@group.calendar.google.com');
  assertEqual(getCalendarId(), 'family@group.calendar.google.com');
});

test('setCalendarId: leere/ungültige ID wird abgelehnt', () => {
  let threw = false;
  try { setCalendarId(''); } catch { threw = true; }
  assert(threw, 'Leere ID muss einen Fehler werfen');
  // Vorherige gültige Auswahl bleibt erhalten
  assertEqual(getCalendarId(), 'family@group.calendar.google.com');
});

test('setCalendarId: Wechsel setzt den Sync-Token zurück', () => {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('google_sync_token', 'abc123')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  setCalendarId('work@group.calendar.google.com');
  assertEqual(cfgGet('google_sync_token'), null, 'Sync-Token muss beim Wechsel gelöscht werden');
});

test('setCalendarId: Wechsel entfernt bestehende Google-Events', () => {
  // Google-Event seeden
  const calRefId = upsertExternalCalendar('google', 'work@group.calendar.google.com', 'Work', '#123456');
  db.prepare(`INSERT INTO calendar_events
    (title, start_datetime, all_day, external_calendar_id, external_source, calendar_ref_id, created_by)
    VALUES ('Altes Event', '2026-06-10T10:00', 0, 'old-evt-220', 'google', ?, 1)`).run(calRefId);
  const before = db.prepare("SELECT COUNT(*) c FROM calendar_events WHERE external_source = 'google'").get().c;
  assert(before > 0, 'Vorbedingung: mindestens ein Google-Event vorhanden');

  setCalendarId('newcal@group.calendar.google.com');

  const after = db.prepare("SELECT COUNT(*) c FROM calendar_events WHERE external_source = 'google'").get().c;
  assertEqual(after, 0, 'Alle Google-Events müssen beim Kalenderwechsel entfernt werden');
});

// --------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
