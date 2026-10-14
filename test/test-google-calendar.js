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
        setReadonly, isReadonly, fetchEventColorMap, householdTimeZone } = __test;
const { nearestColorId } = await import('../server/utils/ical-color.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');

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
  // Das Tagesende in der gesendeten Zone, nach UTC umgerechnet (#1974); die
  // Zonenfaelle stehen in test:google-until-local-day. Hier die Zone UTC, damit
  // die Form nicht an der Zone des Rechners haengt.
  const event = {
    title: 'Wöchentlich bis',
    all_day: 0,
    start_datetime: '2026-06-03T14:00',
    end_datetime:   '2026-06-03T15:00',
    recurrence_rule: 'FREQ=WEEKLY;UNTIL=20260831',
  };
  const g = localEventToGoogle(event, {}, 'UTC');
  assertEqual(g.recurrence[0], 'RRULE:FREQ=WEEKLY;UNTIL=20260831T235959Z');
});

// --------------------------------------------------------
// localEventToGoogle – Zeitzone (Issue #572)
// Regression: die Zone war fest auf 'Europe/Berlin' verdrahtet, wodurch Events
// bei Nutzern außerhalb dieser Zone verschoben in Google landeten (Australien:
// +7,5 h). Die Zone kommt jetzt vom Zielkalender, Fallback ist die Server-Zone.
// --------------------------------------------------------
test('localEventToGoogle: Zielkalender-Zone wird übernommen, Wanduhrzeit bleibt', () => {
  const event = {
    title: 'Meeting',
    all_day: 0,
    start_datetime: '2026-06-03T14:00',
    end_datetime:   '2026-06-03T15:00',
    recurrence_rule: null,
  };
  const g = localEventToGoogle(event, {}, 'Australia/Adelaide');
  assertEqual(g.start.timeZone, 'Australia/Adelaide');
  assertEqual(g.end.timeZone,   'Australia/Adelaide');
  assertEqual(g.start.dateTime, '2026-06-03T14:00:00', 'Uhrzeit wird nicht umgerechnet');
});

test('localEventToGoogle: keine feste Europe/Berlin-Zone mehr (Default = Server-Zone)', () => {
  const prevTz = process.env.TZ;
  process.env.TZ = 'Australia/Adelaide';
  try {
    const g = localEventToGoogle({
      title: 'Ohne Zielzone', all_day: 0,
      start_datetime: '2026-06-03T14:00', end_datetime: '2026-06-03T15:00',
      recurrence_rule: null,
    });
    assertEqual(g.start.timeZone, 'Australia/Adelaide');
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

test('localEventToGoogle: Serie bekommt eine timeZone (Google-Pflichtfeld)', () => {
  const g = localEventToGoogle({
    title: 'Yoga', all_day: 0,
    start_datetime: '2026-06-05T19:00', end_datetime: '2026-06-05T20:00',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU',
  }, {}, 'Australia/Adelaide');
  assert(!!g.start.timeZone, 'start.timeZone gesetzt');
  assertEqual(g.recurrence[0], 'RRULE:FREQ=WEEKLY;BYDAY=TU');
});

test('localEventToGoogle: all-day-Event bleibt ohne timeZone (reines DATE)', () => {
  const g = localEventToGoogle({
    title: 'Urlaub', all_day: 1,
    start_datetime: '2026-06-03', end_datetime: '2026-06-04',
    recurrence_rule: null,
  }, {}, 'Australia/Adelaide');
  assertEqual(g.start.timeZone, undefined);
  assertEqual(g.start.date, '2026-06-03');
});

// Ohne Verbindung (null) faellt householdTimeZone auf die Umgebung zurueck -
// genau der Rueckfall, den der Google-Outbound nimmt, wenn der Zielkalender
// keine Zone meldet. Die Einstellung selbst prueft test-household-timezone.js.
test('householdTimeZone(null): TZ-Env hat Vorrang, sonst gültige IANA-Zone', () => {
  const prevTz = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Auckland';
    assertEqual(householdTimeZone(null), 'Pacific/Auckland');
    delete process.env.TZ;
    const fallback = householdTimeZone(null);
    assert(typeof fallback === 'string' && fallback.length > 0, 'Fallback liefert eine Zone');
    // Muss von Intl akzeptiert werden, sonst weist Google das Event zurück.
    new Intl.DateTimeFormat('en-US', { timeZone: fallback });
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
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

test('localEventToGoogle: eine GELEERTE Farbe wird ausdruecklich geleert (#891/#899)', () => {
  // NICHT weggelassen, sondern null - und der Unterschied ist der ganze Punkt.
  // Der Update-Push ist ein `events.patch`, und ein PATCH fasst nur die Felder
  // an, die im Body STEHEN. Ein fehlendes colorId hiesse "nicht anfassen":
  // Google behielte seine alte Farbe, waehrend Yuvomi die der zugewiesenen
  // Person zeigt, und die beiden blieben dauerhaft verschieden.
  //
  // Bis v2.48.0 war das folgenlos, weil `color` NOT NULL war und dieser Zweig
  // fuer Updates nie erreicht wurde. Der Test stand hier trotzdem - er hat die
  // damals wahre Beobachtung festgehalten statt der Regel dahinter, und waere
  // deshalb gruen geblieben, wenn der Fall real wird.
  const g = localEventToGoogle(
    { title: 'Farblos', all_day: 1, start_datetime: '2026-06-03', color_modified: 1 },
    GOOGLE_EVENT_PALETTE
  );
  assertEqual(g.colorId, null);
  assertEqual('colorId' in g, true, 'das Feld MUSS im Body stehen, sonst loescht der PATCH nichts');
});

test('localEventToGoogle: eine NIE gelernte Farbe loescht Googles Farbe NICHT (#899)', () => {
  // Die Gegenprobe zum Test darueber und der Grund fuer #899: bis dahin ging das
  // null bei JEDEM farblosen Termin hinaus, auch bei einem, der nie eine Farbe
  // hatte. Ein Termin kommt ohne colorId herein (lokal NULL), jemand faerbt ihn
  // spaeter in Google, und die naechste beliebige Bearbeitung in Yuvomi raeumte
  // dessen Farbe ab - ohne dass sie hier je jemand angefasst haette.
  const g = localEventToGoogle(
    { title: 'Nie gefaerbt', all_day: 1, start_datetime: '2026-06-03', color_modified: 0 },
    GOOGLE_EVENT_PALETTE
  );
  assertEqual('colorId' in g, false, 'nie gelernt heisst "nicht anfassen", nicht "loeschen"');
});

test('localEventToGoogle: eine unabbildbare Farbe loescht Googles Farbe NICHT', () => {
  // Die Gegenprobe zum Test darueber, und die Grenze der Regel: eine fehlende
  // PALETTE ist etwas anderes als eine fehlende FARBE. Faellt `colors.get` aus,
  // traegt der Termin sehr wohl eine Farbe - sie laesst sich nur nicht auf eine
  // der 11 colorIds abbilden. Ein Nullwert wuerde hier eine in Google gesetzte
  // Farbe wegwerfen, obwohl niemand das wollte; "nicht anfassen" ist richtig.
  const g = localEventToGoogle(
    { title: 'Rot', all_day: 1, start_datetime: '2026-06-03', color: '#FF0000' },
    {}
  );
  assertEqual(g.colorId, undefined);
  assertEqual('colorId' in g, false, 'ohne Palette darf das Feld gar nicht erst im Body stehen');
});

// --------------------------------------------------------
// upsertGoogleEvents – Event-Farbsync + color_modified-Gate (Issue #219, #427, #899)
// --------------------------------------------------------
console.log('\n[Google Calendar Test] upsertGoogleEvents – Farbsync\n');

// Seed-User: bekommt die ID 1 und war damit genau der Grund, warum diese Suite
// den Fremdschlüssel-Fehler aus #839 nie sehen konnte. Der Fall mit einer
// anderen Besitzer-ID steht am Ende der Datei.
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

test('Erst-Import ohne colorId schreibt KEINE Eigenfarbe (#891)', () => {
  // Bis v2.48.0 landete hier die Kalenderfarbe. Das las sich harmlos - die
  // Anzeige stimmte ja -, machte aber eine GEERBTE Farbe ununterscheidbar von
  // einer, die jemand fuer diesen Termin gewaehlt hat. Da die Eigenfarbe seit
  // #815 vorn steht, hat sie damit die Farbe der zugewiesenen Person auf Dauer
  // verdraengt. Der Termin bleibt farblos; die Kalenderfarbe kommt beim Lesen
  // als cal_color ueber calendar_ref_id dazu, wo sie als geerbt erkennbar ist.
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([gEvent], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color, calendar_ref_id FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.color, null);
  // Gegenprobe: die Farbe ist nicht verloren, nur woanders. Ohne diese Haelfte
  // waere der Test auch dann gruen, wenn der Termin gar keinen Kalender mehr
  // haette und die geerbte Farbe damit wirklich weg waere.
  assertEqual(row.calendar_ref_id, calRefId, 'der Kalenderbezug traegt die geerbte Farbe');
  const cal = db.prepare('SELECT color FROM external_calendars WHERE id = ?').get(calRefId);
  assertEqual(cal.color, '#FF0000', 'und dort steht sie unveraendert');
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

test('Unbekannte colorId schreibt ebenfalls keine Eigenfarbe (#891)', () => {
  // Eine colorId, die in der Palette fehlt, ist keine Farbangabe - also derselbe
  // Fall wie gar keine colorId, nicht ein Anlass, die Kalenderfarbe einzusetzen.
  const colored = { ...gEvent, id: 'evt-colorid-unknown', colorId: '99' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([colored], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get('evt-colorid-unknown');
  assertEqual(row.color, null);
});

test('Re-Sync übernimmt geänderte Google-Farbe, solange color_modified = 0', () => {
  const recolored = { ...gEvent, colorId: '10' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([recolored], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.color, '#00FF00', 'Remote-Farbänderung muss ohne lokalen Override durchkommen');
});

test('Re-Sync überschreibt Farbe NICHT nach lokalem Umfärben (color_modified = 1)', () => {
  // Nutzer ändert die Event-Farbe – die App setzt dabei color_modified = 1.
  db.prepare('UPDATE calendar_events SET color = ?, color_modified = 1 WHERE external_calendar_id = ?')
    .run('#0000FF', gEvent.id);
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([gEvent], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color FROM calendar_events WHERE external_calendar_id = ?'
  ).get(gEvent.id);
  assertEqual(row.color, '#0000FF', 'Benutzerfarbe muss über den Sync hinweg erhalten bleiben');
});

test('Eine Titeländerung friert die Farbe NICHT ein (#899)', () => {
  // Der Repro aus #899 auf Googles Seite: ein Termin kommt ohne colorId herein,
  // der Nutzer aendert in Yuvomi nur den TITEL - das setzt user_modified = 1 -,
  // und danach faerbt ihn jemand in Google. Solange das Farb-Gatter an
  // user_modified hing, kam diese Farbe nie an.
  const fresh = { ...gEvent, id: 'evt-title-edit' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([fresh], calRefId, '#FF0000', COLOR_MAP);
  db.prepare('UPDATE calendar_events SET title = ?, user_modified = 1 WHERE external_calendar_id = ?')
    .run('Team-Meeting (verschoben)', fresh.id);

  upsertGoogleEvents([{ ...fresh, colorId: '6' }], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT color, user_modified FROM calendar_events WHERE external_calendar_id = ?'
  ).get(fresh.id);
  assertEqual(row.color, '#FFA500', 'die Farbe aus Google muss trotz Titelbearbeitung ankommen');
  assertEqual(row.user_modified, 1, 'die Bearbeitung selbst bleibt vermerkt');
});

test('Re-Sync aktualisiert übrige Felder, Farbschutz bei color_modified = 1 bleibt', () => {
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
// Wiederholte Läufe über unveränderte Events. Ein abgelaufener syncToken
// zwingt zum Full-Resync, der den kompletten Kalender erneut liefert - ohne
// Wertvergleich im UPDATE würde davon jede Zeile neu geschrieben.
// --------------------------------------------------------

// Zählt alle Zeilenänderungen seit dem Öffnen der Verbindung.
const totalChanges = () => db.prepare('SELECT total_changes() AS n').get().n;

test('Re-Sync unveränderter Events fasst keine Zeile an', () => {
  const item     = { ...gEvent, id: 'evt-unchanged' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP);

  const before = totalChanges();
  upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP);
  assertEqual(totalChanges() - before, 0, 'unveränderter Re-Sync darf nichts schreiben');
});

// Gegenprobe: der Vergleich darf echte Änderungen nicht wegfiltern. Ein
// falsches Negativ wäre hier Datenverlust, nicht bloß gesparte Schreiblast.
test('Re-Sync mit geändertem Titel kommt weiterhin an', () => {
  const item     = { ...gEvent, id: 'evt-changed' };
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP);

  upsertGoogleEvents(
    [{ ...item, summary: 'Team-Meeting (verschoben)' }], calRefId, '#FF0000', COLOR_MAP
  );
  const row = db.prepare(
    'SELECT title FROM calendar_events WHERE external_calendar_id = ?'
  ).get('evt-changed');
  assertEqual(row.title, 'Team-Meeting (verschoben)', 'Titeländerung muss ankommen');
});

// --------------------------------------------------------
// Zeitzone einer Google-Serie (#829)
//
// Google liefert die IANA-Zone neben der Zeit (start.timeZone), Yuvomi hat sie
// nicht mitgeschrieben. Ohne tzid wiederholt expandRecurringEvents den festen
// Offset des ersten Vorkommens - ueber die Sommer-/Winterzeit-Grenze steht die
// Serie dann eine Stunde falsch. Fuer CalDAV/Apple war das als #549 laengst
// behoben, fuer Google nie nachgezogen.
// --------------------------------------------------------

const torontoSeries = {
  id: 'evt-tz-829',
  status: 'confirmed',
  summary: 'Wochentermin',
  start: { dateTime: '2026-08-24T19:00:00-04:00', timeZone: 'America/Toronto' },
  end:   { dateTime: '2026-08-24T20:00:00-04:00', timeZone: 'America/Toronto' },
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
};
const tzidOf = (id) => db.prepare(
  'SELECT tzid FROM calendar_events WHERE external_calendar_id = ?'
).get(id)?.tzid ?? null;

test('Der Import uebernimmt die Zeitzone, die Google mitliefert', () => {
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  upsertGoogleEvents([torontoSeries], calRefId, '#FF0000', COLOR_MAP);
  assertEqual(tzidOf('evt-tz-829'), 'America/Toronto');
});

test('Ohne Zone am Termin greift die Zone des Kalenders', () => {
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  const item = { ...torontoSeries, id: 'evt-tz-cal', start: { dateTime: '2026-08-24T19:00:00-04:00' } };
  upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP, { calTimeZone: 'America/Toronto' });
  assertEqual(tzidOf('evt-tz-cal'), 'America/Toronto');
});

test('Ein Ganztags-Termin traegt keine Zone', () => {
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  const item = {
    id: 'evt-tz-allday', status: 'confirmed', summary: 'Urlaub',
    start: { date: '2026-08-24' }, end: { date: '2026-08-26' },
  };
  upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP, { calTimeZone: 'America/Toronto' });
  assertEqual(tzidOf('evt-tz-allday'), null);
});

test('Eine Bestandszeile bekommt die Zone beim naechsten Lauf nachgetragen', () => {
  // Der Wertvergleich im UPDATE muss tzid kennen, sonst bliebe die Spalte bei
  // allen vor diesem Fix importierten Serien fuer immer leer.
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  const item = { ...torontoSeries, id: 'evt-tz-backfill' };
  upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP);
  db.prepare('UPDATE calendar_events SET tzid = NULL WHERE external_calendar_id = ?').run('evt-tz-backfill');

  upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP);
  assertEqual(tzidOf('evt-tz-backfill'), 'America/Toronto');
});

test('Die Serie behaelt ihre Ortszeit ueber den Zeitumstellungs-Wechsel', () => {
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  const item = { ...torontoSeries, id: 'evt-tz-dst' };
  upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT * FROM calendar_events WHERE external_calendar_id = ?'
  ).get('evt-tz-dst');

  const wallTime = (iso) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));

  const occurrences = expandRecurringEvents([row], '2026-08-24', '2026-11-30');
  const times = new Set(occurrences.map((o) => wallTime(o.start_datetime)));
  assertEqual(
    [...times].join(','), '19:00',
    'Jedes Vorkommen steht um 19:00 Ortszeit - vor UND nach der Umstellung am 1. November'
  );
});

// --------------------------------------------------------
// created_by ohne den Installations-Nutzer (Issue #839)
// --------------------------------------------------------
// Steht bewusst am Ende: der Abschnitt löscht Nutzer 1, und dessen Termine
// gehen per ON DELETE CASCADE mit. Jeder Test davor hat seine Zusicherungen
// zu diesem Zeitpunkt bereits geprüft.
console.log('\n[Google Calendar Test] created_by ohne Nutzer 1 (#839)\n');

db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('zweiter', 'Zweiter', 'x', 'member')`).run();
const secondUserId = db.prepare(`SELECT id FROM users WHERE username = 'zweiter'`).get().id;
db.prepare(`DELETE FROM users WHERE username = 'admin'`).run();

test('Import läuft weiter, wenn der Nutzer mit ID 1 gelöscht wurde', () => {
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  const item = { ...gEvent, id: 'evt-839-no-user-1' };
  upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP);
  const row = db.prepare(
    'SELECT created_by FROM calendar_events WHERE external_calendar_id = ?'
  ).get('evt-839-no-user-1');
  assert(row, 'Das Event muss angelegt werden - vorher scheiterte der Insert am Fremdschlüssel');
  assertEqual(row.created_by, secondUserId, 'Besitzer ist der erste noch existierende Nutzer');
});

test('Ohne jeden Nutzer wird übersprungen, statt am Fremdschlüssel zu scheitern', () => {
  db.prepare('DELETE FROM users').run();
  const calRefId = upsertExternalCalendar('google', 'primary', 'Mein Kalender', '#FF0000');
  const item = { ...gEvent, id: 'evt-839-no-user-at-all' };

  // Dass hinterher keine Zeile steht, sichert für sich genommen nichts zu - das
  // galt auch vorher, nur weil der Insert abstürzte. Zusicherung ist, dass er
  // gar nicht erst versucht wird, und das steht im Fehlerkanal.
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try { upsertGoogleEvents([item], calRefId, '#FF0000', COLOR_MAP); }
  finally { console.error = realError; }

  assert(
    !errors.some((line) => line.includes('FOREIGN KEY')),
    `Kein Insert-Versuch ohne Besitzer erwartet, geloggt wurde: ${errors.join(' | ')}`
  );
  const row = db.prepare(
    'SELECT id FROM calendar_events WHERE external_calendar_id = ?'
  ).get('evt-839-no-user-at-all');
  assertEqual(row, undefined, 'Kein Nutzer, kein Besitzer - und der Lauf bricht trotzdem nicht ab');
});

// --------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
