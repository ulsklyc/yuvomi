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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
