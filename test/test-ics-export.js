import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL DEFAULT '#007AFF',
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[10]); // ics_subscriptions
db.exec(MIGRATIONS_SQL[11]); // calendar_events ics columns
db.exec(MIGRATIONS_SQL[61]); // feed token

console.log('\n[ICS-Export-Test]\n');

test('Migration 61 fügt calendar_feed_token hinzu', () => {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  assert(cols.includes('calendar_feed_token'), 'Spalte fehlt');
});

test('Feed-Token ist unique', () => {
  db.prepare(`INSERT INTO users (username,display_name,password_hash,calendar_feed_token) VALUES ('a','A','x','tok1')`).run();
  let threw = false;
  try { db.prepare(`INSERT INTO users (username,display_name,password_hash,calendar_feed_token) VALUES ('b','B','x','tok1')`).run(); }
  catch { threw = true; }
  assert(threw, 'UNIQUE sollte feuern');
});

test('Mehrere NULL-Token erlaubt (Partial-Index)', () => {
  db.prepare(`INSERT INTO users (username,display_name,password_hash) VALUES ('c','C','x')`).run();
  db.prepare(`INSERT INTO users (username,display_name,password_hash) VALUES ('d','D','x')`).run();
  assert(true);
});

test('Migration 80 fügt calendar_feed_show_assignees hinzu (Default 0)', () => {
  db.exec(MIGRATIONS_SQL[80]);
  const col = db.prepare(`PRAGMA table_info(users)`).all()
    .find(c => c.name === 'calendar_feed_show_assignees');
  assert(col, 'Spalte fehlt');
  assert(Number(col.dflt_value) === 0, 'Default sollte 0 sein');
});

import { buildFeed, escapeICSText, foldLine } from '../server/services/ics-export.js';

// Frische DB mit calendar_events + ics_subscriptions
const d2 = new DatabaseSync(':memory:');
d2.exec('PRAGMA foreign_keys = ON;');
d2.exec(`CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#007AFF', avatar_data BLOB,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '');`);
d2.exec(MIGRATIONS_SQL[10]);
d2.exec(MIGRATIONS_SQL[11]);
d2.exec(`CREATE VIRTUAL TABLE search_index USING fts5(
  entity UNINDEXED, entity_id UNINDEXED, title, body
);`); // migration 194 rebuilds the event slice
d2.exec(MIGRATIONS_SQL[27]); // legacy calendar attachment bodies
d2.exec(MIGRATIONS_SQL[61]);
d2.exec("ALTER TABLE calendar_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all';");
d2.exec(MIGRATIONS_SQL[80]);
d2.exec(MIGRATIONS_SQL[85]); // calendar_event_exceptions (EXDATE, #489)
d2.exec(MIGRATIONS_SQL[97]); // calendar_events.tzid (DST-Export, #549)
d2.exec(MIGRATIONS_SQL[194]); // linked occurrence overrides
d2.exec(`CREATE TABLE IF NOT EXISTS event_assignments (
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);`);
const u1 = d2.prepare(`INSERT INTO users (username,display_name,password_hash,role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;
const u2 = d2.prepare(`INSERT INTO users (username,display_name,password_hash) VALUES ('maria','Maria','x')`).run().lastInsertRowid;

const NOW = new Date('2026-06-22T00:00:00Z');
// Die Haushaltszone wird explizit übergeben statt aus serverTimeZone() gelesen: die
// CI läuft unter UTC, dort fiele der ganze TZID-Pfad (#818) ungetestet durch.
const FEED_TZ = 'Europe/Madrid';

function eventBlock(ics, summary) {
  return (ics.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [])
    .find((block) => block.includes(`SUMMARY:${summary}\r\n`));
}

test('escapeICSText maskiert Sonderzeichen', () => {
  assert(escapeICSText('a,b;c\\d\ne') === 'a\\,b\\;c\\\\d\\ne', escapeICSText('a,b;c\\d\ne'));
});

test('foldLine faltet lange Zeilen mit CRLF + Space', () => {
  const long = 'X'.repeat(100);
  const folded = foldLine('SUMMARY:' + long);
  assert(folded.includes('\r\n '), 'keine Faltung');
  assert(folded.split('\r\n').every(seg => seg.replace(/^ /, '').length <= 75), 'Segment zu lang');
});

test('buildFeed enthält eigenes lokales Event', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,created_by) VALUES ('Zahnarzt','2026-06-25T09:00:00Z','2026-06-25T10:00:00Z',0,'local',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('BEGIN:VCALENDAR'), 'kein VCALENDAR');
  assert(ics.includes('SUMMARY:Zahnarzt'), 'Titel fehlt');
  assert(ics.includes('DTSTART:20260625T090000Z'), 'DTSTART falsch: ' + ics);
  assert(ics.includes('DTEND:20260625T100000Z'), 'DTEND falsch: ' + ics);
  assert(/DTSTART:20260625T090000Z\r\n/.test(ics), 'DTSTART sollte mit Z (UTC) enden, extern/offset-behaftete Eingabe darf nicht in floating local übergehen: ' + ics);
});

test('buildFeed: naives lokales Event trägt die Haushaltszone, unveränderte Ziffern (#818)', () => {
  // Spiegelt exakt, was das Erstellen-Formular erzeugt: kein Offset, keine Sekunden.
  // Zwei Fehler sind hier möglich, und der Feed hatte nacheinander beide:
  //   1. blindes 'Z' anhängen → die Wanduhrzeit wird als UTC gelesen (verschoben).
  //   2. floating local time (keine Zone) → Google, Apple, Thunderbird, Outlook und
  //      Home Assistant legen sie ebenfalls auf UTC (#818), nur diesmal RFC-konform.
  // Richtig ist beides nicht: die Ziffern bleiben, und sie bekommen ihre Zone.
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,created_by) VALUES ('Naiv','2026-06-26T14:30','2026-06-26T15:30',0,'local',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('SUMMARY:Naiv'), 'Titel fehlt');
  assert(/DTSTART;TZID=Europe\/Madrid:20260626T143000\r\n/.test(ics), 'DTSTART ohne TZID oder mit falschen Ziffern: ' + ics);
  assert(/DTEND;TZID=Europe\/Madrid:20260626T153000\r\n/.test(ics), 'DTEND ohne TZID oder mit falschen Ziffern: ' + ics);
  assert(!/DTSTART:20260626T143000/.test(ics), 'DTSTART darf nicht mehr floating (ohne TZID) sein: ' + ics);
  assert(!/20260626T143000Z/.test(ics), 'die Wanduhrzeit darf nicht als UTC ausgegeben werden: ' + ics);
});

test('buildFeed: die Haushaltszone steht als X-WR-TIMEZONE im Kalenderkopf (#818)', () => {
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('\r\nX-WR-TIMEZONE:Europe/Madrid\r\n'), 'X-WR-TIMEZONE fehlt: ' + ics);
  assert(ics.indexOf('X-WR-TIMEZONE') < ics.indexOf('BEGIN:VEVENT'), 'Header muss vor den VEVENTs stehen: ' + ics);
});

test('buildFeed: die Haushaltszone bekommt ihr eigenes VTIMEZONE (#818)', () => {
  // Ohne die Komponente kann ein strikter Abonnent die TZID nicht auflösen und
  // fällt auf UTC zurück - genau der Fehler, den der TZID-Parameter beheben soll.
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('\r\nTZID:Europe/Madrid'), 'VTIMEZONE der Haushaltszone fehlt: ' + ics);
  const block = ics.slice(ics.indexOf('TZID:Europe/Madrid'), ics.indexOf('END:VTIMEZONE', ics.indexOf('TZID:Europe/Madrid')));
  assert(block.includes('TZOFFSETTO:+0200'), 'CEST-Offset fehlt: ' + block);
  assert(block.includes('TZOFFSETTO:+0100'), 'CET-Offset fehlt: ' + block);
  assert(ics.indexOf('BEGIN:VTIMEZONE') < ics.indexOf('BEGIN:VEVENT'), 'VTIMEZONE muss vor den VEVENTs stehen: ' + ics);
});

test('buildFeed: UTC als Haushaltszone → Z statt eines VTIMEZONE über UTC (#818)', () => {
  // Bei TZ=UTC ist die Wanduhr des Haushalts die UTC-Uhr: das 'Z' sagt dasselbe
  // wie ein TZID, und zwar in einer Form, die jeder Client kennt.
  const ics = buildFeed(d2, u1, NOW, 'UTC');
  assert(ics.includes('DTSTART:20260626T143000Z'), 'naiver Wert sollte unter UTC ein Z tragen: ' + ics);
  assert(!/X-WR-TIMEZONE/.test(ics), 'kein X-WR-TIMEZONE für UTC: ' + ics);
  assert(!/\r\nTZID:UTC/.test(ics), 'kein VTIMEZONE über UTC: ' + ics);
});

test('buildFeed: unauflösbare Zone fällt auf UTC zurück statt eine kaputte TZID zu schreiben', () => {
  const ics = buildFeed(d2, u1, NOW, 'Nicht/EineZone');
  assert(!/TZID=Nicht\/EineZone/.test(ics), 'ungültige TZID im Feed: ' + ics);
  assert(ics.includes('DTSTART:20260626T143000Z'), 'Fallback sollte UTC sein: ' + ics);
});

test('buildFeed: Event mit explizitem Offset (z.B. Google-Sync) wird korrekt nach UTC konvertiert', () => {
  // Google liefert RFC3339 mit Offset statt Z, z.B. '+02:00'. formatUTC() darf hier
  // KEIN 'Z' anhängen (sonst '...+02:00Z' → Date invalid → 'NaN...' im Feed).
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,created_by) VALUES ('Google-Termin','2026-06-25T09:00:00+02:00','2026-06-25T10:00:00+02:00',0,'local',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('SUMMARY:Google-Termin'), 'Titel fehlt');
  assert(!/NaN/.test(ics), 'Feed enthält NaN: ' + ics);
  assert(ics.includes('DTSTART:20260625T070000Z'), 'DTSTART falsch nach UTC konvertiert: ' + ics);
  assert(ics.includes('DTEND:20260625T080000Z'), 'DTEND falsch nach UTC konvertiert: ' + ics);
});

test('buildFeed: Ganztags-Event nutzt VALUE=DATE, DTEND exklusiv', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,created_by) VALUES ('Urlaub','2026-07-01','2026-07-03',1,'local',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('DTSTART;VALUE=DATE:20260701'), 'DTSTART date fehlt: ' + ics);
  assert(ics.includes('DTEND;VALUE=DATE:20260704'), 'DTEND exklusiv (+1) fehlt: ' + ics);
});

test('buildFeed: RRULE wird mit Präfix übernommen', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('Müll','2026-01-05T07:00:00Z',0,'local','FREQ=WEEKLY;BYDAY=MO',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'), 'RRULE fehlt: ' + ics);
});

test('buildFeed: eine eingelesene Serie bekommt kein zweites RRULE-Präfix (#761)', () => {
  // Lokal angelegte Termine speichern den nackten Regelkörper, aus ICS/CalDAV
  // eingelesene den vollen Property-String MIT Präfix (ics-parser.js). Der Feed
  // setzte eins davor, ohne zu schauen: `RRULE:RRULE:FREQ=...`. Apple schluckte
  // das, Home Assistant verwarf das ganze Event.
  //
  // Gezählt statt per includes() geprüft: der Test darüber wäre auch mit dem
  // Fehler grün gewesen, weil `RRULE:FREQ=WEEKLY;BYDAY=MO` ein Teilstring von
  // `RRULE:RRULE:FREQ=WEEKLY;BYDAY=MO` ist.
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('Aus Nextcloud','2026-01-06T07:00:00Z',0,'local','RRULE:FREQ=DAILY;INTERVAL=2',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);

  const line = ics.split('\r\n').find((l) => l.includes('FREQ=DAILY;INTERVAL=2'));
  assert(line, 'die Regel fehlt ganz: ' + ics);
  assert(line === 'RRULE:FREQ=DAILY;INTERVAL=2', 'Zeile lautet: ' + line);

  // Und keine einzige Zeile im ganzen Feed trägt ein doppeltes Präfix.
  const doubled = ics.split('\r\n').filter((l) => /^RRULE:RRULE:/i.test(l));
  assert(doubled.length === 0, 'doppeltes RRULE-Präfix im Feed: ' + doubled.join(' | '));
});

test('buildFeed: EXDATE für ausgenommene Instanz einer Zeit-Serie (#489)', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('Gym','2026-02-03T18:00:00Z',0,'local','FREQ=WEEKLY;BYDAY=TU',?)`).run(u1).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-02-10')`).run(id);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  // Zeit-Teil der Master-Startzeit (18:00:00Z) auf das Ausnahme-Datum angewandt.
  assert(ics.includes('EXDATE:20260210T180000Z'), 'EXDATE (Zeit) fehlt: ' + ics);
});

test('buildFeed: EXDATE mit VALUE=DATE für Ganztags-Serie (#489)', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('Standup','2026-03-02',1,'local','FREQ=WEEKLY;BYDAY=MO',?)`).run(u1).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-03-09')`).run(id);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('EXDATE;VALUE=DATE:20260309'), 'EXDATE (Ganztags) fehlt: ' + ics);
});

test('buildFeed: Ganztags-Override nutzt Master-UID und RECURRENCE-ID ohne gepaarte EXDATE', () => {
  const masterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,created_by)
    VALUES ('OverrideDayMaster','2026-08-01','2026-08-01',1,'local','FREQ=DAILY;COUNT=4',?)
  `).run(u1).lastInsertRowid;
  const childId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('OverrideDayMoved','2026-08-05','2026-08-05',1,'local',?,?,?,?)
  `).run(u1, masterId, '2026-08-02', JSON.stringify(['title', 'start_datetime', 'end_datetime'])).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-08-02')`).run(masterId);

  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  const master = eventBlock(ics, 'OverrideDayMaster');
  const child = eventBlock(ics, 'OverrideDayMoved');
  assert(master, 'Master-VEVENT fehlt: ' + ics);
  assert(child, 'Replacement-VEVENT fehlt: ' + ics);
  assert(master.includes(`UID:event-${masterId}@yuvomi`), 'Master-UID falsch: ' + master);
  assert(master.includes('RRULE:FREQ=DAILY;COUNT=4'), 'Master-RRULE fehlt: ' + master);
  assert(!master.includes('EXDATE;VALUE=DATE:20260802'), 'Linked slot darf nicht zugleich EXDATE sein: ' + master);
  assert(child.includes(`UID:event-${masterId}@yuvomi`), 'Replacement muss Master-UID nutzen: ' + child);
  assert(!child.includes(`UID:event-${childId}@yuvomi`), 'Replacement darf keine Child-UID nutzen: ' + child);
  assert(child.includes('RECURRENCE-ID;VALUE=DATE:20260802'), 'RECURRENCE-ID passt nicht zum EXDATE-Slot: ' + child);
  assert(child.includes('DTSTART;VALUE=DATE:20260805'), 'verschobenes DTSTART fehlt: ' + child);
  assert(!child.includes('RRULE:'), 'Replacement darf keine RRULE tragen: ' + child);
});

test('buildFeed: naiver Override nutzt Master-UID und Feed-Zonen-Slot ohne gepaarte EXDATE', () => {
  const masterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,created_by)
    VALUES ('OverrideFloatingMaster','2026-09-01T09:30','2026-09-01T10:30',0,'local','FREQ=DAILY;COUNT=4',?)
  `).run(u1).lastInsertRowid;
  const childId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('OverrideFloatingMoved','2026-09-05T11:00','2026-09-05T12:00',0,'local',?,?,?,?)
  `).run(u1, masterId, '2026-09-02', JSON.stringify(['title', 'start_datetime', 'end_datetime'])).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-09-02')`).run(masterId);

  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  const master = eventBlock(ics, 'OverrideFloatingMaster');
  const child = eventBlock(ics, 'OverrideFloatingMoved');
  assert(!master?.includes('EXDATE;TZID=Europe/Madrid:20260902T093000'), 'Linked slot darf nicht zugleich EXDATE sein: ' + master);
  assert(child, 'Replacement-VEVENT fehlt: ' + ics);
  assert(child.includes(`UID:event-${masterId}@yuvomi`), 'Replacement muss Master-UID nutzen: ' + child);
  assert(!child.includes(`UID:event-${childId}@yuvomi`), 'Replacement darf keine Child-UID nutzen: ' + child);
  assert(child.includes('RECURRENCE-ID;TZID=Europe/Madrid:20260902T093000'), 'RECURRENCE-ID passt nicht zum Feed-Zonen-Slot: ' + child);
  assert(child.includes('DTSTART;TZID=Europe/Madrid:20260905T110000'), 'verschobenes DTSTART falsch: ' + child);
  assert(child.includes('DTEND;TZID=Europe/Madrid:20260905T120000'), 'verschobenes DTEND falsch: ' + child);
  assert(!child.includes('RRULE:'), 'Replacement darf keine RRULE tragen: ' + child);
});

test('buildFeed: verschobener Monats-Override behält sein eigenes DTSTART', () => {
  const masterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,tzid,created_by)
    VALUES ('OverrideMonthEndMaster','2026-07-31T07:00:00Z','2026-07-31T08:00:00Z',0,
      'local','FREQ=MONTHLY;BYMONTHDAY=-1','Europe/Madrid',?)
  `).run(u1).lastInsertRowid;
  d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,tzid,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('OverrideMonthEndMoved','2026-08-03T07:00:00Z','2026-08-03T08:00:00Z',0,
      'local','Europe/Madrid',?,?,?,?)
  `).run(u1, masterId, '2026-07-31', JSON.stringify(['title', 'start_datetime', 'end_datetime']));
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date)
    VALUES (?, '2026-07-31')`).run(masterId);

  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  const child = eventBlock(ics, 'OverrideMonthEndMoved');
  assert(child, 'Replacement-VEVENT fehlt: ' + ics);
  assert(child.includes('RECURRENCE-ID;TZID=Europe/Madrid:20260731T090000'),
    'RECURRENCE-ID muss den ursprünglichen Juli-Slot behalten: ' + child);
  assert(child.includes('DTSTART;TZID=Europe/Madrid:20260803T090000'),
    'DTSTART muss das verschobene Datum behalten: ' + child);
  assert(child.includes('DTEND;TZID=Europe/Madrid:20260803T100000'),
    'DTEND muss mit dem verschobenen Datum erhalten bleiben: ' + child);
  assert(!child.includes('20260831T090000'),
    'Die Master-Regel darf das Replacement nicht auf das Monatsende setzen: ' + child);
});

test('buildFeed: TZID-Override nutzt Master-UID und zonengleichen Slot ohne gepaarte EXDATE', () => {
  const masterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,tzid,created_by)
    VALUES ('OverrideTzidMaster','2026-10-24T08:00:00Z','2026-10-24T09:00:00Z',0,'local','FREQ=DAILY;COUNT=4','Europe/Berlin',?)
  `).run(u1).lastInsertRowid;
  const childId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,tzid,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('OverrideTzidMoved','2026-10-27T09:00:00Z','2026-10-27T10:00:00Z',0,'local','Europe/Berlin',?,?,?,?)
  `).run(u1, masterId, '2026-10-25', JSON.stringify(['title', 'start_datetime', 'end_datetime'])).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-10-25')`).run(masterId);

  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  const master = eventBlock(ics, 'OverrideTzidMaster');
  const child = eventBlock(ics, 'OverrideTzidMoved');
  assert(!master?.includes('EXDATE;TZID=Europe/Berlin:'), 'Linked slot darf nicht zugleich EXDATE sein: ' + master);
  assert(child, 'Replacement-VEVENT fehlt: ' + ics);
  assert(child.includes(`UID:event-${masterId}@yuvomi`), 'Replacement muss Master-UID nutzen: ' + child);
  assert(!child.includes(`UID:event-${childId}@yuvomi`), 'Replacement darf keine Child-UID nutzen: ' + child);
  assert(child.includes('RECURRENCE-ID;TZID=Europe/Berlin:20261025T100000'), 'RECURRENCE-ID passt nicht zum TZID-Slot: ' + child);
  assert(child.includes('DTSTART;TZID=Europe/Berlin:20261027T100000'), 'verschobenes DTSTART falsch: ' + child);
  assert(child.includes('DTEND;TZID=Europe/Berlin:20261027T110000'), 'verschobenes DTEND falsch: ' + child);
  assert(!child.includes('RRULE:'), 'Replacement darf keine RRULE tragen: ' + child);
});

test('buildFeed: TZID-Override nutzt bei positivem Mitternachtsversatz den Basis-Instant', () => {
  const masterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,tzid,created_by)
    VALUES ('OverrideTokyoMaster','2026-01-06T23:00:00Z','2026-01-07T00:00:00Z',0,'local','FREQ=DAILY;COUNT=4','Asia/Tokyo',?)
  `).run(u1).lastInsertRowid;
  d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,tzid,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('OverrideTokyoMoved','2026-06-30T02:00:00Z','2026-06-30T03:00:00Z',0,'local','Asia/Tokyo',?,?,?,?)
  `).run(u1, masterId, '2026-01-07', JSON.stringify(['title', 'start_datetime', 'end_datetime']));
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-01-07')`).run(masterId);

  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  const master = eventBlock(ics, 'OverrideTokyoMaster');
  const child = eventBlock(ics, 'OverrideTokyoMoved');
  assert(!master?.includes('EXDATE;TZID=Asia/Tokyo:'), 'Linked slot darf nicht zugleich EXDATE sein: ' + master);
  assert(child?.includes('RECURRENCE-ID;TZID=Asia/Tokyo:20260108T080000'), 'RECURRENCE-ID muss den lokalen Basis-Instant nutzen: ' + child);
});

test('buildFeed: TZID-Override nutzt bei negativem Mitternachtsversatz den DST-Basis-Instant', () => {
  const masterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,tzid,created_by)
    VALUES ('OverrideLosAngelesMaster','2026-03-08T01:30:00Z','2026-03-08T02:30:00Z',0,'local','FREQ=DAILY;COUNT=4','America/Los_Angeles',?)
  `).run(u1).lastInsertRowid;
  d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,tzid,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('OverrideLosAngelesMoved','2026-07-01T19:00:00Z','2026-07-01T20:00:00Z',0,'local','America/Los_Angeles',?,?,?,?)
  `).run(u1, masterId, '2026-03-09', JSON.stringify(['title', 'start_datetime', 'end_datetime']));
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-03-09')`).run(masterId);

  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  const master = eventBlock(ics, 'OverrideLosAngelesMaster');
  const child = eventBlock(ics, 'OverrideLosAngelesMoved');
  assert(!master?.includes('EXDATE;TZID=America/Los_Angeles:'), 'Linked slot darf nicht zugleich EXDATE sein: ' + master);
  // 17:30, NICHT 18:30 - nachgezogen beim Rebase auf main (#985/#549).
  //
  // Der Master ist "taeglich 17:30 Ortszeit" (2026-03-08T01:30Z = 07.03. 17:30 LA),
  // und zwischen dem ersten und dem zweiten Vorkommen liegt die US-Umstellung vom
  // 08.03.2026. Diese Probe erwartete bis hierher 18:30 und schrieb damit die alte
  // Rechnung fest: fester UTC-Suffix (01:30Z) je Vorkommen, wodurch die ORTSZEIT
  // ueber die Grenze springt. Genau diese Drift ist der Fehler aus #549, den #985
  // behoben hat - seither wird je Vorkommen die lokale Wanduhrzeit gehalten und
  // nach UTC zurueckgerechnet (2026-03-09T00:30Z). Derselbe Slot, benannt nach der
  // Ortszeit, die er wirklich hat.
  assert(child?.includes('RECURRENCE-ID;TZID=America/Los_Angeles:20260308T173000'), 'RECURRENCE-ID muss den DST-korrigierten Basis-Instant nutzen: ' + child);
});

test('buildFeed: verschobener Ersatz behält seinen abgelaufenen Master im Feed', () => {
  const masterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,created_by)
    VALUES ('ExpiredOverrideMaster','2025-01-01','2025-01-01',1,'local','FREQ=DAILY;UNTIL=20250102',?)
  `).run(u1).lastInsertRowid;
  d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('ExpiredOverrideMoved','2026-06-20','2026-06-20',1,'local',?,?,?,?)
  `).run(u1, masterId, '2025-01-02', JSON.stringify(['title', 'start_datetime', 'end_datetime']));
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2025-01-02')`).run(masterId);

  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  const master = eventBlock(ics, 'ExpiredOverrideMaster');
  const child = eventBlock(ics, 'ExpiredOverrideMoved');
  assert(master, 'referenzierter abgelaufener Master fehlt: ' + ics);
  assert(master.includes(`UID:event-${masterId}@yuvomi`), 'Master-UID fehlt: ' + master);
  assert(master.includes('RRULE:FREQ=DAILY;UNTIL=20250102'), 'Master-RRULE fehlt: ' + master);
  assert(!master.includes('EXDATE;VALUE=DATE:20250102'), 'Linked slot darf nicht zugleich EXDATE sein: ' + master);
  assert(child?.includes(`UID:event-${masterId}@yuvomi`), 'Replacement muss die Master-UID nutzen: ' + child);
  assert(child.includes('RECURRENCE-ID;VALUE=DATE:20250102'), 'Replacement-Slot fehlt: ' + child);
});

test('buildFeed: linked private and assignee-only series remain household-feed events', () => {
  const privateMasterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,
       visibility,created_by)
    VALUES ('HouseholdPrivateMaster','2026-11-01T09:00','2026-11-01T10:00',0,
            'local','FREQ=DAILY;COUNT=2','private',?)
  `).run(u2).lastInsertRowid;
  d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,visibility,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('HouseholdPrivateChild','2026-11-03T09:00','2026-11-03T10:00',0,
            'local','private',?,?,?,?)
  `).run(u2, privateMasterId, '2026-11-02', JSON.stringify([
    'title', 'start_datetime', 'end_datetime',
  ]));
  d2.prepare(`
    INSERT INTO calendar_event_exceptions (event_id,exception_date)
    VALUES (?, '2026-11-02')
  `).run(privateMasterId);

  const assignedMasterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,
       visibility,created_by)
    VALUES ('HouseholdAssignedMaster','2026-12-01T09:00','2026-12-01T10:00',0,
            'local','FREQ=DAILY;COUNT=2','assignees',?)
  `).run(u2).lastInsertRowid;
  d2.prepare('INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)')
    .run(assignedMasterId, u2);
  d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,visibility,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('HouseholdAssignedChild','2026-12-03T09:00','2026-12-03T10:00',0,
            'local','assignees',?,?,?,?)
  `).run(u2, assignedMasterId, '2026-12-02', JSON.stringify([
    'title', 'start_datetime', 'end_datetime',
  ]));
  d2.prepare(`
    INSERT INTO calendar_event_exceptions (event_id,exception_date)
    VALUES (?, '2026-12-02')
  `).run(assignedMasterId);

  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  for (const title of [
    'HouseholdPrivateMaster', 'HouseholdPrivateChild',
    'HouseholdAssignedMaster', 'HouseholdAssignedChild',
  ]) {
    assert(ics.includes(`SUMMARY:${title}`), `${title} fehlt im ungefilterten Haushaltsfeed`);
  }
});

test('buildFeed: unreachable linked child degrades standalone and keeps the master EXDATE', () => {
  const masterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,
       visibility,created_by)
    VALUES ('UnreachableFeedMaster','2026-11-01T09:00','2026-11-01T10:00',0,
            'local','FREQ=MONTHLY;COUNT=2','all',?)
  `).run(u1).lastInsertRowid;
  const childId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,visibility,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('UnreachableFeedChild','2026-11-08T11:00','2026-11-08T12:00',0,
            'local','all',?,?,?,?)
  `).run(u1, masterId, '2026-11-02', JSON.stringify([
    'title', 'start_datetime', 'end_datetime',
  ])).lastInsertRowid;
  d2.prepare(`
    INSERT INTO calendar_event_exceptions (event_id,exception_date)
    VALUES (?, '2026-11-02')
  `).run(masterId);

  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  const master = eventBlock(ics, 'UnreachableFeedMaster');
  const child = eventBlock(ics, 'UnreachableFeedChild');
  assert(master?.includes('EXDATE;TZID=Europe/Madrid:20261102T090000'),
    'unreachable replacement must not resurrect the excluded master slot: ' + master);
  assert(child?.includes(`UID:event-${childId}@yuvomi`),
    'unreachable child must retain its standalone identity: ' + child);
  assert(!child?.includes('RECURRENCE-ID'),
    'unreachable child must not claim a recurrence slot the rule cannot reach: ' + child);
  d2.prepare('DELETE FROM calendar_events WHERE id = ?').run(masterId);
});

test('buildFeed resolves linked rows without reading legacy attachment bodies', () => {
  const largeAttachment = 'A'.repeat(1024 * 1024);
  const masterId = d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,
       attachment_data,created_by)
    VALUES ('FeedAttachmentMaster','2026-07-01T09:00','2026-07-01T10:00',0,
            'local','FREQ=DAILY;COUNT=2',?,?)
  `).run(largeAttachment, u1).lastInsertRowid;
  d2.prepare(`
    INSERT INTO calendar_events
      (title,start_datetime,end_datetime,all_day,external_source,attachment_data,created_by,
       recurrence_parent_id,recurrence_id,overridden_fields)
    VALUES ('FeedAttachmentChild','2026-07-03T09:00','2026-07-03T10:00',0,
            'local',?,?,?,?,?)
  `).run(
    largeAttachment,
    u1,
    masterId,
    '2026-07-02',
    JSON.stringify(['title', 'start_datetime', 'end_datetime']),
  );
  d2.prepare(`
    INSERT INTO calendar_event_exceptions (event_id,exception_date)
    VALUES (?, '2026-07-02')
  `).run(masterId);

  const originalPrepare = d2.prepare.bind(d2);
  const statements = [];
  d2.prepare = (sql) => {
    statements.push(String(sql));
    return originalPrepare(sql);
  };
  let ics;
  try {
    ics = buildFeed(d2, u1, NOW, FEED_TZ);
  } finally {
    delete d2.prepare;
  }

  assert(ics.includes('SUMMARY:FeedAttachmentChild'), 'linked replacement fehlt');
  const calendarReads = statements.filter((sql) => /\b(?:FROM|JOIN)\s+calendar_events\b/i.test(sql));
  assert(calendarReads.length > 0, 'keine Kalenderabfrage aufgezeichnet');
  assert(calendarReads.every((sql) => !/\be\.\*|\battachment_data\b/i.test(sql)),
    `Attachment-Body in kompakter Kalenderabfrage: ${calendarReads.join('\n---\n')}`);
});

test('buildFeed: wiederkehrendes Event mit abgelaufenem UNTIL (Vergangenheit) wird ausgeschlossen', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('AlteSerie','2019-01-07T07:00:00Z',0,'local','FREQ=WEEKLY;BYDAY=MO;UNTIL=20200101T000000Z',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(!ics.includes('AlteSerie'), 'abgelaufene Serie (UNTIL in Vergangenheit) sollte nicht im Feed sein: ' + ics);
});

test('buildFeed: wiederkehrendes Event mit zukünftigem UNTIL bleibt enthalten', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('LaufendeSerie','2026-01-05T07:00:00Z',0,'local','FREQ=WEEKLY;BYDAY=MO;UNTIL=20271231T000000Z',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('LaufendeSerie'), 'Serie mit zukünftigem UNTIL sollte im Feed sein: ' + ics);
});

test('buildFeed: geteiltes ICS-Abo-Event ist enthalten', () => {
  const shared = d2.prepare(`INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES ('Ferien','https://x/f.ics','#000',1,?)`).run(u2).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,external_calendar_id,subscription_id,created_by) VALUES ('Sommerferien','2026-07-20',1,'ics','sf@x',?,?)`).run(shared, u2);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('SUMMARY:Sommerferien'), 'geteiltes Abo-Event fehlt');
});

test('buildFeed: fremdes nicht-geteiltes ICS-Abo-Event fehlt', () => {
  const priv = d2.prepare(`INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES ('Privat','https://x/p.ics','#000',0,?)`).run(u2).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,external_calendar_id,subscription_id,created_by) VALUES ('GeheimMaria','2026-07-21',1,'ics','gm@x',?,?)`).run(priv, u2);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(!ics.includes('GeheimMaria'), 'fremdes privates Abo-Event darf nicht erscheinen');
});

test('buildFeed: altes nicht-wiederkehrendes Event außerhalb Fenster fehlt', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,created_by) VALUES ('Uralt','2020-01-01',1,'local',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(!ics.includes('Uralt'), '90-Tage-Fenster nicht angewandt');
});

import { getFeedToken, regenerateFeedToken, clearFeedToken, findUserIdByFeedToken }
  from '../server/services/ics-export.js';

test('regenerateFeedToken erzeugt Token und persistiert', () => {
  const tok = regenerateFeedToken(d2, u1);
  assert(typeof tok === 'string' && tok.length >= 32, 'Token zu kurz');
  assert(getFeedToken(d2, u1) === tok, 'nicht persistiert');
});

test('findUserIdByFeedToken findet Nutzer', () => {
  const tok = regenerateFeedToken(d2, u2);
  assert(findUserIdByFeedToken(d2, tok) === u2, 'Lookup falsch');
  assert(findUserIdByFeedToken(d2, 'unbekannt') === null, 'unbekannter Token darf null sein');
});

test('regenerate ersetzt alten Token (alter wird ungültig)', () => {
  const oldTok = regenerateFeedToken(d2, u1);
  const newTok = regenerateFeedToken(d2, u1);
  assert(oldTok !== newTok, 'Token unverändert');
  assert(findUserIdByFeedToken(d2, oldTok) === null, 'alter Token noch gültig');
  assert(findUserIdByFeedToken(d2, newTok) === u1, 'neuer Token ungültig');
});

test('clearFeedToken deaktiviert Feed', () => {
  regenerateFeedToken(d2, u1);
  clearFeedToken(d2, u1);
  assert(getFeedToken(d2, u1) === null, 'Token nicht gelöscht');
});

// --------------------------------------------------------------------------
// Zugewiesene Personen im Feed-Titel (#482)
// --------------------------------------------------------------------------
import { getFeedShowAssignees, setFeedShowAssignees }
  from '../server/services/ics-export.js';

const u3 = d2.prepare(`INSERT INTO users (username,display_name,password_hash) VALUES ('sam','Sam (Jr.), II','x')`).run().lastInsertRowid;

const poolId = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,created_by) VALUES ('Poolparty','2026-06-28',1,'local',?)`).run(u1).lastInsertRowid;
d2.prepare(`INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)`).run(poolId, u1); // Admin
d2.prepare(`INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)`).run(poolId, u2); // Maria

const soloId = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,created_by) VALUES ('Elternabend','2026-06-29',1,'local',?)`).run(u1).lastInsertRowid;
d2.prepare(`INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)`).run(soloId, u3); // Name mit , und ( )

test('getFeedShowAssignees Default false, setFeedShowAssignees persistiert Bool', () => {
  assert(getFeedShowAssignees(d2, u1) === false, 'Default sollte false sein');
  assert(setFeedShowAssignees(d2, u1, true) === true, 'Rückgabe true');
  assert(getFeedShowAssignees(d2, u1) === true, 'nicht persistiert');
  setFeedShowAssignees(d2, u1, 1);
  assert(getFeedShowAssignees(d2, u1) === true, 'truthy → 1');
  setFeedShowAssignees(d2, u1, 0);
  assert(getFeedShowAssignees(d2, u1) === false, 'falsy → 0');
});

test('buildFeed: Flag aus → Titel ohne Namen-Suffix', () => {
  setFeedShowAssignees(d2, u1, false);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(/SUMMARY:Poolparty\r\n/.test(ics), 'Titel sollte unverändert sein: ' + ics);
  assert(!/Poolparty \(/.test(ics), 'Suffix trotz Flag aus');
});

test('buildFeed: Flag an → mehrere Zugewiesene alphabetisch als Suffix', () => {
  setFeedShowAssignees(d2, u1, true);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  // display_name-Sortierung: "Admin" < "Maria"; Komma zwischen Namen RFC-escaped.
  assert(ics.includes('SUMMARY:Poolparty (Admin\\, Maria)'), 'Suffix falsch: ' + ics);
});

test('buildFeed: Flag an aber Feed-Eigentümer eines anderen ohne Flag → kein Suffix', () => {
  // u2 hat calendar_feed_show_assignees nicht gesetzt (Default 0): dessen Feed bleibt roh.
  setFeedShowAssignees(d2, u1, true);
  const ics = buildFeed(d2, u2, NOW, FEED_TZ);
  assert(/SUMMARY:Poolparty\r\n/.test(ics), 'Fremd-Feed darf keinen Suffix haben: ' + ics);
});

test('buildFeed: Sonderzeichen im Namen werden im Suffix escaped', () => {
  setFeedShowAssignees(d2, u1, true);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  // Name "Sam (Jr.), II" → Klammern bleiben, Komma wird zu \,
  assert(ics.includes('SUMMARY:Elternabend (Sam (Jr.)\\, II)'), 'Escaping falsch: ' + ics);
});

test('buildFeed: Event ohne Zuweisung bekommt trotz Flag keine leeren Klammern', () => {
  setFeedShowAssignees(d2, u1, true);
  const noneId = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,created_by) VALUES ('Solo','2026-06-30',1,'local',?)`).run(u1).lastInsertRowid;
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(/SUMMARY:Solo\r\n/.test(ics), 'leere Klammern angehängt: ' + ics);
  d2.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(noneId);
});

// --------------------------------------------------------
// #549: TZID-Export für wiederkehrende Serien. Ohne TZID+VTIMEZONE expandiert die
// App des Abonnenten die UTC-verankerte Serie mit fixem Suffix → DST-Drift im Feed.
// --------------------------------------------------------
setFeedShowAssignees(d2, u1, false); // Suffix-Flag aus, damit SUMMARY exakt bleibt

test('buildFeed: TZID-Serie → DTSTART;TZID mit lokaler Wanduhrzeit (nicht UTC)', () => {
  // Synchronisierte Serie: UTC gespeichert (05:25Z = 07:25 CEST), tzid Europe/Berlin.
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,recurrence_rule,tzid,created_by) VALUES ('SchuleTZ','2025-09-24T05:25:00Z','2025-09-24T06:10:00Z',0,'apple','FREQ=WEEKLY',?, ?)`).run('Europe/Berlin', u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('DTSTART;TZID=Europe/Berlin:20250924T072500'), 'DTSTART;TZID (lokal 07:25) fehlt: ' + ics);
  assert(ics.includes('DTEND;TZID=Europe/Berlin:20250924T081000'), 'DTEND;TZID (lokal 08:10) fehlt: ' + ics);
  assert(!/DTSTART;TZID=Europe\/Berlin:\d{8}T052500/.test(ics), 'DTSTART darf nicht die UTC-Zeit tragen: ' + ics);
});

test('buildFeed: referenzierte Zone bekommt ein korrektes VTIMEZONE (Europe/Berlin)', () => {
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('BEGIN:VTIMEZONE'), 'VTIMEZONE fehlt: ' + ics);
  assert(ics.includes('\r\nTZID:Europe/Berlin'), 'VTIMEZONE TZID fehlt: ' + ics);
  assert(ics.includes('BEGIN:DAYLIGHT') && ics.includes('BEGIN:STANDARD'), 'DST-Komponenten fehlen: ' + ics);
  assert(ics.includes('TZOFFSETTO:+0200'), 'CEST-Offset fehlt: ' + ics);
  assert(ics.includes('TZOFFSETTO:+0100'), 'CET-Offset fehlt: ' + ics);
  assert(ics.includes('BYMONTH=3;BYDAY=-1SU'), 'Frühjahrs-Regel (letzter So März) fehlt: ' + ics);
  assert(ics.includes('BYMONTH=10;BYDAY=-1SU'), 'Herbst-Regel (letzter So Okt) fehlt: ' + ics);
  // VTIMEZONE steht vor dem ersten VEVENT (RFC 5545).
  assert(ics.indexOf('BEGIN:VTIMEZONE') < ics.indexOf('BEGIN:VEVENT'), 'VTIMEZONE muss vor den VEVENTs stehen: ' + ics);
});

test('buildFeed: pro Zone genau ein VTIMEZONE (dedupliziert)', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,tzid,created_by) VALUES ('SchuleTZ2','2025-09-25T05:25:00Z',0,'apple','FREQ=WEEKLY',?, ?)`).run('Europe/Berlin', u1);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  const count = (ics.match(/\r\nTZID:Europe\/Berlin/g) || []).length;
  assert(count === 1, `genau ein VTIMEZONE je Zone erwartet, gefunden: ${count}`);
});

test('buildFeed: Zone ohne Sommerzeit → einzelne STANDARD-Komponente, kein DAYLIGHT', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,tzid,created_by) VALUES ('TokyoTZ','2026-01-06T23:00:00Z',0,'apple','FREQ=WEEKLY',?, ?)`).run('Asia/Tokyo', u1).lastInsertRowid;
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  // Tokio: +09:00 ganzjährig, 23:00Z = 08:00 lokal (Folgetag).
  assert(ics.includes('\r\nTZID:Asia/Tokyo'), 'Tokio-VTIMEZONE fehlt: ' + ics);
  const tzBlock = ics.slice(ics.indexOf('TZID:Asia/Tokyo'), ics.indexOf('END:VTIMEZONE', ics.indexOf('TZID:Asia/Tokyo')));
  assert(tzBlock.includes('TZOFFSETTO:+0900'), 'JST-Offset fehlt: ' + tzBlock);
  assert(!tzBlock.includes('BEGIN:DAYLIGHT'), 'Zone ohne DST darf kein DAYLIGHT haben: ' + tzBlock);
  d2.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
});

test('buildFeed: EXDATE einer TZID-Serie trägt TZID + lokale Zeit', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,tzid,created_by) VALUES ('SchuleTZEx','2025-09-26T05:25:00Z',0,'apple','FREQ=WEEKLY',?, ?)`).run('Europe/Berlin', u1).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2025-12-19')`).run(id);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('EXDATE;TZID=Europe/Berlin:20251219T072500'), 'EXDATE;TZID (lokal) fehlt: ' + ics);
  d2.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
});

test('buildFeed: TZID-EXDATE nutzt bei positivem Mitternachtsversatz denselben Slot wie die Expansion', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,tzid,created_by) VALUES ('TokyoTZEx','2026-01-06T23:00:00Z',0,'apple','FREQ=DAILY;COUNT=4',?, ?)`).run('Asia/Tokyo', u1).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-01-07')`).run(id);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('EXDATE;TZID=Asia/Tokyo:20260108T080000'), 'EXDATE muss den lokalen Basis-Instant nutzen: ' + ics);
  d2.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
});

test('buildFeed: TZID-EXDATE nutzt bei negativem Mitternachtsversatz den DST-korrigierten Slot', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,tzid,created_by) VALUES ('LosAngelesTZEx','2026-03-08T01:30:00Z',0,'apple','FREQ=DAILY;COUNT=4',?, ?)`).run('America/Los_Angeles', u1).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-03-09')`).run(id);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  // 08.03. 01:30Z ist am Serienanfang 07.03. 17:30 PST. Nach dem
  // DST-Wechsel bleibt die Wanduhr bei 17:30, nicht beim alten UTC-Suffix.
  assert(ics.includes('EXDATE;TZID=America/Los_Angeles:20260308T173000'), 'EXDATE muss den DST-korrigierten Basis-Instant nutzen: ' + ics);
  d2.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
});

for (const { zone, start, dateKey, expected } of [
  { zone: 'America/Los_Angeles', start: '2026-10-31T00:30:00Z', dateKey: '2026-11-02', expected: '20261101T173000' },
  { zone: 'Pacific/Auckland', start: '2026-04-03T22:30:00Z', dateKey: '2026-04-05', expected: '20260406T113000' },
]) {
  test(`buildFeed: EXDATE behaelt die Wanduhr ueber das DST-Ende in ${zone}`, () => {
    const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,tzid,created_by) VALUES ('DSTEndEx',?,0,'apple','FREQ=DAILY;COUNT=4',?,?)`).run(start, zone, u1).lastInsertRowid;
    try {
      d2.prepare('INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?,?)').run(id, dateKey);
      const ics = buildFeed(d2, u1, NOW, FEED_TZ);
      assert(ics.includes(`EXDATE;TZID=${zone}:${expected}`), 'EXDATE muss die lokale Serienzeit behalten: ' + ics);
    } finally {
      d2.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
    }
  });
}

test('buildFeed: unerreichbare TZID-EXDATE bleibt exportierbar statt den Feed zu beenden', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,tzid,created_by) VALUES ('LegacyTZEx','2025-09-26T05:25:00Z',0,'apple','FREQ=WEEKLY;COUNT=1',?, ?)`).run('Europe/Berlin', u1).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2025-12-20')`).run(id);
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('EXDATE;TZID=Europe/Berlin:20251220T072500'), 'historische EXDATE muss erhalten bleiben: ' + ics);
  d2.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
});

test('buildFeed: EINZELtermin mit tzid bleibt UTC (nur Serien nutzen den TZID-Pfad)', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,tzid,created_by) VALUES ('EinzelTZ','2026-06-25T05:25:00Z','2026-06-25T06:10:00Z',0,'apple',?, ?)`).run('Europe/Berlin', u1).lastInsertRowid;
  const ics = buildFeed(d2, u1, NOW, FEED_TZ);
  assert(ics.includes('DTSTART:20260625T052500Z'), 'Einzeltermin sollte UTC bleiben: ' + ics);
  assert(!/SchuleTZ[^\r]*\r\nDTSTART:20260625/.test(ics), 'kein TZID-Pfad für Einzeltermin');
  d2.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
});

test('kein Modul baut die RRULE-Zeile an der Normalisierung vorbei (#761)', () => {
  // WARUM ALS REGEL UND NICHT ALS DATEILISTE: die Regel "genau ein RRULE:-Präfix"
  // lag in fünf Modulen als fünf Kopien. Vier waren richtig, das fünfte nicht -
  // und weil niemand die Kopien zählte, fiel es erst einem Abonnenten auf.
  // Geprüft wird deshalb jede Datei unter server/, auch die, die es noch nicht
  // gibt: wer `RRULE:` unmittelbar aus einem Ausdruck zusammensetzt, muss dabei
  // durch rruleValue()/rruleLine() gegangen sein.
  //
  // Nicht getroffen wird literaler Regeltext (`RRULE:FREQ=YEARLY;BYMONTH=${…}`),
  // wie ihn der VTIMEZONE-Block baut - dort steht hinter dem Doppelpunkt eine
  // Konstante, kein fremder Regelkörper.
  const root = new URL('../server/', import.meta.url);
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) { walk(child); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name === 'recurrence.js') continue; // dort WOHNT die Regel

      const src = readFileSync(child, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!/`RRULE:\$\{/.test(line)) return;
        if (/rrule(Value|Line)\(/.test(line)) return;
        offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(root);

  assert(offenders.length === 0, 'RRULE-Zeile ohne Normalisierung:\n  ' + offenders.join('\n  '));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
