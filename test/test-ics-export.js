import { DatabaseSync } from 'node:sqlite';
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
  avatar_color TEXT NOT NULL DEFAULT '#007AFF', role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '');`);
d2.exec(MIGRATIONS_SQL[10]);
d2.exec(MIGRATIONS_SQL[11]);
d2.exec(MIGRATIONS_SQL[61]);
d2.exec(MIGRATIONS_SQL[80]);
d2.exec(MIGRATIONS_SQL[85]); // calendar_event_exceptions (EXDATE, #489)
d2.exec(MIGRATIONS_SQL[97]); // calendar_events.tzid (DST-Export, #549)
d2.exec(`CREATE TABLE IF NOT EXISTS event_assignments (
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);`);
const u1 = d2.prepare(`INSERT INTO users (username,display_name,password_hash,role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;
const u2 = d2.prepare(`INSERT INTO users (username,display_name,password_hash) VALUES ('maria','Maria','x')`).run().lastInsertRowid;

const NOW = new Date('2026-06-22T00:00:00Z');

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
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('BEGIN:VCALENDAR'), 'kein VCALENDAR');
  assert(ics.includes('SUMMARY:Zahnarzt'), 'Titel fehlt');
  assert(ics.includes('DTSTART:20260625T090000Z'), 'DTSTART falsch: ' + ics);
  assert(ics.includes('DTEND:20260625T100000Z'), 'DTEND falsch: ' + ics);
  assert(/DTSTART:20260625T090000Z\r\n/.test(ics), 'DTSTART sollte mit Z (UTC) enden, extern/offset-behaftete Eingabe darf nicht in floating local übergehen: ' + ics);
});

test('buildFeed: naives lokales Event (ohne Z) wird als floating local time exportiert, NICHT als UTC', () => {
  // Spiegelt exakt, was das Erstellen-Formular erzeugt: kein Offset, keine Sekunden.
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,created_by) VALUES ('Naiv','2026-06-26T14:30','2026-06-26T15:30',0,'local',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('SUMMARY:Naiv'), 'Titel fehlt');
  assert(ics.includes('DTSTART:20260626T143000'), 'DTSTART-Ziffern falsch: ' + ics);
  assert(ics.includes('DTEND:20260626T153000'), 'DTEND-Ziffern falsch: ' + ics);
  // Regression: vorher hätte formatUTC() fälschlich ein 'Z' angehängt und das Event
  // als UTC interpretiert (Verschiebung um die Server-Zeitzone beim Client). Floating
  // local time darf KEIN 'Z' tragen.
  assert(!/DTSTART:20260626T143000Z/.test(ics), 'DTSTART darf kein Z (UTC-Marker) tragen: ' + ics);
  assert(!/DTEND:20260626T153000Z/.test(ics), 'DTEND darf kein Z (UTC-Marker) tragen: ' + ics);
  assert(/DTSTART:20260626T143000\r\n/.test(ics), 'DTSTART-Zeile muss exakt ohne Z enden: ' + ics);
  assert(/DTEND:20260626T153000\r\n/.test(ics), 'DTEND-Zeile muss exakt ohne Z enden: ' + ics);
});

test('buildFeed: Event mit explizitem Offset (z.B. Google-Sync) wird korrekt nach UTC konvertiert', () => {
  // Google liefert RFC3339 mit Offset statt Z, z.B. '+02:00'. formatUTC() darf hier
  // KEIN 'Z' anhängen (sonst '...+02:00Z' → Date invalid → 'NaN...' im Feed).
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,created_by) VALUES ('Google-Termin','2026-06-25T09:00:00+02:00','2026-06-25T10:00:00+02:00',0,'local',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('SUMMARY:Google-Termin'), 'Titel fehlt');
  assert(!/NaN/.test(ics), 'Feed enthält NaN: ' + ics);
  assert(ics.includes('DTSTART:20260625T070000Z'), 'DTSTART falsch nach UTC konvertiert: ' + ics);
  assert(ics.includes('DTEND:20260625T080000Z'), 'DTEND falsch nach UTC konvertiert: ' + ics);
});

test('buildFeed: Ganztags-Event nutzt VALUE=DATE, DTEND exklusiv', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,created_by) VALUES ('Urlaub','2026-07-01','2026-07-03',1,'local',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('DTSTART;VALUE=DATE:20260701'), 'DTSTART date fehlt: ' + ics);
  assert(ics.includes('DTEND;VALUE=DATE:20260704'), 'DTEND exklusiv (+1) fehlt: ' + ics);
});

test('buildFeed: RRULE wird mit Präfix übernommen', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('Müll','2026-01-05T07:00:00Z',0,'local','FREQ=WEEKLY;BYDAY=MO',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'), 'RRULE fehlt: ' + ics);
});

test('buildFeed: EXDATE für ausgenommene Instanz einer Zeit-Serie (#489)', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('Gym','2026-02-03T18:00:00Z',0,'local','FREQ=WEEKLY;BYDAY=TU',?)`).run(u1).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-02-10')`).run(id);
  const ics = buildFeed(d2, u1, NOW);
  // Zeit-Teil der Master-Startzeit (18:00:00Z) auf das Ausnahme-Datum angewandt.
  assert(ics.includes('EXDATE:20260210T180000Z'), 'EXDATE (Zeit) fehlt: ' + ics);
});

test('buildFeed: EXDATE mit VALUE=DATE für Ganztags-Serie (#489)', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('Standup','2026-03-02',1,'local','FREQ=WEEKLY;BYDAY=MO',?)`).run(u1).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_event_exceptions (event_id,exception_date) VALUES (?, '2026-03-09')`).run(id);
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('EXDATE;VALUE=DATE:20260309'), 'EXDATE (Ganztags) fehlt: ' + ics);
});

test('buildFeed: wiederkehrendes Event mit abgelaufenem UNTIL (Vergangenheit) wird ausgeschlossen', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('AlteSerie','2019-01-07T07:00:00Z',0,'local','FREQ=WEEKLY;BYDAY=MO;UNTIL=20200101T000000Z',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW);
  assert(!ics.includes('AlteSerie'), 'abgelaufene Serie (UNTIL in Vergangenheit) sollte nicht im Feed sein: ' + ics);
});

test('buildFeed: wiederkehrendes Event mit zukünftigem UNTIL bleibt enthalten', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,created_by) VALUES ('LaufendeSerie','2026-01-05T07:00:00Z',0,'local','FREQ=WEEKLY;BYDAY=MO;UNTIL=20271231T000000Z',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('LaufendeSerie'), 'Serie mit zukünftigem UNTIL sollte im Feed sein: ' + ics);
});

test('buildFeed: geteiltes ICS-Abo-Event ist enthalten', () => {
  const shared = d2.prepare(`INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES ('Ferien','https://x/f.ics','#000',1,?)`).run(u2).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,external_calendar_id,subscription_id,created_by) VALUES ('Sommerferien','2026-07-20',1,'ics','sf@x',?,?)`).run(shared, u2);
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('SUMMARY:Sommerferien'), 'geteiltes Abo-Event fehlt');
});

test('buildFeed: fremdes nicht-geteiltes ICS-Abo-Event fehlt', () => {
  const priv = d2.prepare(`INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES ('Privat','https://x/p.ics','#000',0,?)`).run(u2).lastInsertRowid;
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,external_calendar_id,subscription_id,created_by) VALUES ('GeheimMaria','2026-07-21',1,'ics','gm@x',?,?)`).run(priv, u2);
  const ics = buildFeed(d2, u1, NOW);
  assert(!ics.includes('GeheimMaria'), 'fremdes privates Abo-Event darf nicht erscheinen');
});

test('buildFeed: altes nicht-wiederkehrendes Event außerhalb Fenster fehlt', () => {
  d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,created_by) VALUES ('Uralt','2020-01-01',1,'local',?)`).run(u1);
  const ics = buildFeed(d2, u1, NOW);
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
  const ics = buildFeed(d2, u1, NOW);
  assert(/SUMMARY:Poolparty\r\n/.test(ics), 'Titel sollte unverändert sein: ' + ics);
  assert(!/Poolparty \(/.test(ics), 'Suffix trotz Flag aus');
});

test('buildFeed: Flag an → mehrere Zugewiesene alphabetisch als Suffix', () => {
  setFeedShowAssignees(d2, u1, true);
  const ics = buildFeed(d2, u1, NOW);
  // display_name-Sortierung: "Admin" < "Maria"; Komma zwischen Namen RFC-escaped.
  assert(ics.includes('SUMMARY:Poolparty (Admin\\, Maria)'), 'Suffix falsch: ' + ics);
});

test('buildFeed: Flag an aber Feed-Eigentümer eines anderen ohne Flag → kein Suffix', () => {
  // u2 hat calendar_feed_show_assignees nicht gesetzt (Default 0): dessen Feed bleibt roh.
  setFeedShowAssignees(d2, u1, true);
  const ics = buildFeed(d2, u2, NOW);
  assert(/SUMMARY:Poolparty\r\n/.test(ics), 'Fremd-Feed darf keinen Suffix haben: ' + ics);
});

test('buildFeed: Sonderzeichen im Namen werden im Suffix escaped', () => {
  setFeedShowAssignees(d2, u1, true);
  const ics = buildFeed(d2, u1, NOW);
  // Name "Sam (Jr.), II" → Klammern bleiben, Komma wird zu \,
  assert(ics.includes('SUMMARY:Elternabend (Sam (Jr.)\\, II)'), 'Escaping falsch: ' + ics);
});

test('buildFeed: Event ohne Zuweisung bekommt trotz Flag keine leeren Klammern', () => {
  setFeedShowAssignees(d2, u1, true);
  const noneId = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,created_by) VALUES ('Solo','2026-06-30',1,'local',?)`).run(u1).lastInsertRowid;
  const ics = buildFeed(d2, u1, NOW);
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
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('DTSTART;TZID=Europe/Berlin:20250924T072500'), 'DTSTART;TZID (lokal 07:25) fehlt: ' + ics);
  assert(ics.includes('DTEND;TZID=Europe/Berlin:20250924T081000'), 'DTEND;TZID (lokal 08:10) fehlt: ' + ics);
  assert(!/DTSTART;TZID=Europe\/Berlin:\d{8}T052500/.test(ics), 'DTSTART darf nicht die UTC-Zeit tragen: ' + ics);
});

test('buildFeed: referenzierte Zone bekommt ein korrektes VTIMEZONE (Europe/Berlin)', () => {
  const ics = buildFeed(d2, u1, NOW);
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
  const ics = buildFeed(d2, u1, NOW);
  const count = (ics.match(/\r\nTZID:Europe\/Berlin/g) || []).length;
  assert(count === 1, `genau ein VTIMEZONE je Zone erwartet, gefunden: ${count}`);
});

test('buildFeed: Zone ohne Sommerzeit → einzelne STANDARD-Komponente, kein DAYLIGHT', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,recurrence_rule,tzid,created_by) VALUES ('TokyoTZ','2026-01-06T23:00:00Z',0,'apple','FREQ=WEEKLY',?, ?)`).run('Asia/Tokyo', u1).lastInsertRowid;
  const ics = buildFeed(d2, u1, NOW);
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
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('EXDATE;TZID=Europe/Berlin:20251219T072500'), 'EXDATE;TZID (lokal) fehlt: ' + ics);
  d2.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
});

test('buildFeed: EINZELtermin mit tzid bleibt UTC (nur Serien nutzen den TZID-Pfad)', () => {
  const id = d2.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,external_source,tzid,created_by) VALUES ('EinzelTZ','2026-06-25T05:25:00Z','2026-06-25T06:10:00Z',0,'apple',?, ?)`).run('Europe/Berlin', u1).lastInsertRowid;
  const ics = buildFeed(d2, u1, NOW);
  assert(ics.includes('DTSTART:20260625T052500Z'), 'Einzeltermin sollte UTC bleiben: ' + ics);
  assert(!/SchuleTZ[^\r]*\r\nDTSTART:20260625/.test(ics), 'kein TZID-Pfad für Einzeltermin');
  d2.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
