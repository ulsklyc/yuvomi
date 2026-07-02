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
        upsertGoogleEvents, upsertExternalCalendar,
        setReadonly, isReadonly, fetchEventColorMap } = __test;
const { nearestColorId } = await import('../server/utils/ical-color.js');

// Reale Google-Event-Palette (colors.get → event), Basis für Nearest-Match.
const GOOGLE_EVENT_PALETTE = {
  '1': '#A4BDFC', '2': '#7AE7BF', '3': '#DBADFF', '4': '#FF887C',
  '5': '#FBD75B', '6': '#FFB878', '7': '#46D6DB', '8': '#E1E1E1',
  '9': '#5484ED', '10': '#51B749', '11': '#DC2127',
};

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
// googleAllDayEndToInclusive – Google exklusiv → Yuvomi inklusiv
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
// localAllDayEndToExclusive – Yuvomi inklusiv → Google exklusiv
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
// Regression: Issue #217 – Yuvomi speichert getimte Events als
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
// Outbound-Farbe: Hex → nächste Google-colorId (#427, Schritt 2)
// --------------------------------------------------------
test('nearestColorId: exakter Palettentreffer', () => {
  assertEqual(nearestColorId('#DC2127', GOOGLE_EVENT_PALETTE), '11');
});

test('nearestColorId: minimal verschobene Farbe trifft dieselbe ID', () => {
  assertEqual(nearestColorId('#DD2228', GOOGLE_EVENT_PALETTE), '11');
});

test('nearestColorId: Yuvomi-Preset-Blau → Blueberry (9)', () => {
  assertEqual(nearestColorId('#007AFF', GOOGLE_EVENT_PALETTE), '9');
});

test('nearestColorId: leere Palette → null', () => {
  assertEqual(nearestColorId('#007AFF', {}), null);
});

test('nearestColorId: ungültiges Ziel-Hex → null', () => {
  assertEqual(nearestColorId('nicht-hex', GOOGLE_EVENT_PALETTE), null);
});

test('localEventToGoogle: event.color wird zur nächsten colorId', () => {
  const g = localEventToGoogle(
    { title: 'Rot', all_day: 1, start_datetime: '2026-06-03', color: '#DC2127' },
    GOOGLE_EVENT_PALETTE
  );
  assertEqual(g.colorId, '11');
});

test('localEventToGoogle: ohne Palette bleibt colorId ungesetzt', () => {
  const g = localEventToGoogle(
    { title: 'Rot', all_day: 1, start_datetime: '2026-06-03', color: '#DC2127' },
    {}
  );
  assertEqual(g.colorId, undefined);
});

test('localEventToGoogle: ohne event.color bleibt colorId ungesetzt', () => {
  const g = localEventToGoogle(
    { title: 'Farblos', all_day: 1, start_datetime: '2026-06-03' },
    GOOGLE_EVENT_PALETTE
  );
  assertEqual(g.colorId, undefined);
});

// --------------------------------------------------------
// upsertGoogleEvents – Event-Farbsync + user_modified-Gate (Issue #219, #427)
// --------------------------------------------------------
console.log('\n[Google Calendar Test] upsertGoogleEvents – Farbsync\n');

// Seed-User (created_by = 1 in upsertGoogleEvents)
db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();

// colorId → Hex, wie fetchEventColorMap es aus colors.get aufbaut.
const COLOR_MAP = { '6': '#FFA500', '10': '#00FF00' };

const gEvent = {
  id: 'evt-color-219',
  status: 'confirmed',
  summary: 'Team-Meeting',
  start: { dateTime: '2026-06-03T10:00:00Z' },
  end:   { dateTime: '2026-06-03T11:00:00Z' },
};

test('Erst-Import ohne colorId setzt die Kalenderfarbe als Default', () => {
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([gEvent], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.color, '#FF0000');
});

test('colorId wird zur Event-Eigenfarbe aufgelöst (#427)', () => {
  const colored = { ...gEvent, id: 'evt-colorid', colorId: '6' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([colored], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get('evt-colorid');
  assertEqual(row.color, '#FFA500', 'colorId 6 muss auf den Paletten-Hex gemappt werden');
});

test('Unbekannte colorId fällt auf die Kalenderfarbe zurück', () => {
  const colored = { ...gEvent, id: 'evt-colorid-unknown', colorId: '99' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([colored], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get('evt-colorid-unknown');
  assertEqual(row.color, '#FF0000');
});

test('Re-Sync übernimmt geänderte Google-Farbe, solange user_modified = 0', () => {
  const recolored = { ...gEvent, colorId: '10' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([recolored], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.color, '#00FF00', 'Remote-Farbänderung muss ohne lokalen Override durchkommen');
});

test('Re-Sync überschreibt Farbe NICHT nach lokalem Umfärben (user_modified = 1)', () => {
  // Nutzer ändert die Event-Farbe – die App setzt dabei user_modified = 1.
  db.prepare('UPDATE calendar_events SET color = ?, user_modified = 1 WHERE external_calendar_id = ?')
    .run('#0000FF', gEvent.id);
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([gEvent], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.color, '#0000FF', 'Benutzerfarbe muss über den Sync hinweg erhalten bleiben');
});

test('Re-Sync aktualisiert übrige Felder, Farbschutz bei user_modified = 1 bleibt', () => {
  const updated = { ...gEvent, summary: 'Team-Meeting (verschoben)' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([updated], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT title, color FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.title, 'Team-Meeting (verschoben)');
  assertEqual(row.color, '#0000FF', 'Farbe bleibt trotz Titeländerung erhalten');
});

// --------------------------------------------------------
// Hilfsfunktion (von den Read-only-Tests genutzt)
// --------------------------------------------------------
function cfgGet(key) {
  const row = db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

// --------------------------------------------------------
// setReadonly / isReadonly / getStatus (Issue #236)
// --------------------------------------------------------
console.log('\n[Google Calendar Test] Read-only-Flag (Issue #236)\n');

// Hilfsfunktion cfgGet ist bereits oben definiert.

test('setReadonly true: speichert Flag in sync_config', () => {
  setReadonly(true);
  assertEqual(cfgGet('google_readonly'), '1');
});

test('setReadonly false: löscht Flag aus sync_config', () => {
  setReadonly(false);
  assertEqual(cfgGet('google_readonly'), null);
});

test('isReadonly: false wenn Flag nicht gesetzt', () => {
  db.prepare("DELETE FROM sync_config WHERE key = 'google_readonly'").run();
  assert(!isReadonly(), 'isReadonly() muss false sein');
});

test('isReadonly: true nach setReadonly(true)', () => {
  setReadonly(true);
  assert(isReadonly(), 'isReadonly() muss true sein');
  setReadonly(false); // aufräumen
});

// --------------------------------------------------------
// fetchEventColorMap – Palette-Cache (Optimierung)
// --------------------------------------------------------
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}

console.log('\n[Google Calendar Test] fetchEventColorMap – Palette-Cache\n');

// Muss VOR dem Erfolgsfall laufen, solange der Modul-Cache noch leer ist.
await testAsync('Fehler ohne vorhandenen Cache → leeres Objekt', async () => {
  const failing = { colors: { get: async () => { throw new Error('boom'); } } };
  const map = await fetchEventColorMap(failing);
  assertEqual(Object.keys(map).length, 0);
});

let paletteCalls = 0;
const okCalendar = { colors: { get: async () => {
  paletteCalls++;
  return { data: { event: { '11': { background: '#dc2127' } } } };
} } };

await testAsync('Erster Aufruf lädt die Palette und normalisiert auf Uppercase', async () => {
  const map = await fetchEventColorMap(okCalendar);
  assertEqual(map['11'], '#DC2127');
  assertEqual(paletteCalls, 1);
});

await testAsync('Zweiter Aufruf trifft den Cache (kein weiterer colors.get)', async () => {
  const map = await fetchEventColorMap(okCalendar);
  assertEqual(map['11'], '#DC2127');
  assertEqual(paletteCalls, 1, 'colors.get darf innerhalb der TTL nicht erneut aufgerufen werden');
});

// --------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
