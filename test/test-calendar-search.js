/**
 * Modul: Kalender-Such-Test (#471)
 * Zweck: Validiert Migration 76 — Termine sind über Titel, Beschreibung UND Ort
 *        im FTS5-Index `search_index` auffindbar, inkl. Backfill bestehender
 *        Zeilen und Reindex bei UPDATE/DELETE. Spiegelt die FTS-Query, auf der
 *        GET /api/v1/calendar/search aufsetzt.
 * Ausführen: node --experimental-sqlite test/test-calendar-search.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { buildMatchQuery, resolveEventSearchRows } from '../server/services/search.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);
db.exec(MIGRATIONS_SQL[44]); // FTS5-Index + Event-Trigger (nur Titel/Beschreibung)

console.log('\n[Calendar-Search-Test] FTS über Titel/Beschreibung/Ort (#471)\n');

const u = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();
const uid = u.lastInsertRowid;

function addEvent({ title, description = null, location = null, start }) {
  return db.prepare(`INSERT INTO calendar_events (title, description, location, start_datetime, created_by)
    VALUES (?, ?, ?, ?, ?)`).run(title, description, location, start, uid).lastInsertRowid;
}

// Spiegelt die Kernabfrage aus GET /api/v1/calendar/search (ohne die Anzeige-Joins).
function search(q) {
  const match = buildMatchQuery(q);
  if (!match) return [];
  return db.prepare(`
    SELECT e.id, e.title, e.location, e.start_datetime
    FROM search_index s
    JOIN calendar_events e ON e.id = s.entity_id
    WHERE s.entity = 'event' AND s.search_index MATCH ?
    ORDER BY e.start_datetime ASC
  `).all(match);
}

// Termin VOR Migration 76 anlegen: der alte Trigger indexiert den Ort noch nicht.
const preId = addEvent({
  title: 'Kontrolle',
  description: 'jährlicher Check',
  location: 'Zahnarztpraxis Nord',
  start: '2030-03-01T09:00:00Z',
});

test('vor Migration 76 ist der Ort nicht indexiert', () => {
  assert(search('Zahnarztpraxis').length === 0, 'Ort sollte vor 76 nicht auffindbar sein');
  assert(search('Kontrolle').length === 1, 'Titel ist bereits auffindbar');
});

// Migration 76 anwenden: Trigger neu, Ort in den Body, Bestandszeilen backfillen.
db.exec(MIGRATIONS_SQL[76]);
db.exec(MIGRATIONS_SQL[85]); // calendar_event_exceptions
db.exec(MIGRATIONS_SQL[194]); // linked occurrence overrides + occurrence-aware FTS

test('Migration 76 backfillt bestehende Termine mit ihrem Ort', () => {
  const hits = search('Zahnarztpraxis');
  assert(hits.length === 1, `erwartet 1 Treffer, erhielt ${hits.length}`);
  assert(hits[0].id === Number(preId), 'falscher Treffer');
});

// Neue Termine nach 76: ai-Trigger indexiert Titel + Beschreibung + Ort.
const dentist = addEvent({ title: 'Zahnreinigung', description: 'Prophylaxe', location: 'Dr. Meier, Hauptstraße 5', start: '2030-04-10T08:30:00Z' });
const soccer  = addEvent({ title: 'Fußballtraining', description: 'Trikot mitbringen', location: 'Sportplatz Ost', start: '2030-02-15T17:00:00Z' });
const dinner  = addEvent({ title: 'Abendessen', description: 'bei Oma', location: null, start: '2030-05-20T19:00:00Z' });

test('Termin über Titel auffindbar', () => {
  assert(search('Zahnreinigung').some((e) => e.id === Number(dentist)), 'Titel-Treffer fehlt');
});

test('Termin über Beschreibung auffindbar', () => {
  const hits = search('Oma');
  assert(hits.length === 1 && hits[0].id === Number(dinner), 'Beschreibungs-Treffer fehlt');
});

test('Termin über Ort auffindbar (Kernanforderung #471)', () => {
  assert(search('Sportplatz').some((e) => e.id === Number(soccer)), 'Ort-Treffer fehlt');
  assert(search('Hauptstraße').some((e) => e.id === Number(dentist)), 'Straßen-Treffer fehlt');
});

test('Präfix-Suche greift auch bei Ortsstichworten', () => {
  assert(search('Sport').some((e) => e.id === Number(soccer)), 'Präfix-Ort-Treffer fehlt');
});

test('Treffer sind chronologisch nach start_datetime sortiert', () => {
  // Alle vier Termine haben unterschiedliche Monate; Suche nach gemeinsamem Token.
  const all = search('a'); // greift breit über Präfix
  const dates = all.map((e) => e.start_datetime);
  const sorted = [...dates].sort();
  assert(JSON.stringify(dates) === JSON.stringify(sorted), 'nicht chronologisch sortiert');
});

test('UPDATE des Orts reindexiert (au-Trigger)', () => {
  db.prepare(`UPDATE calendar_events SET location = ? WHERE id = ?`).run('Vereinsheim West', soccer);
  assert(search('Vereinsheim').some((e) => e.id === Number(soccer)), 'neuer Ort nicht auffindbar');
  assert(search('Sportplatz').length === 0, 'alter Ort weiterhin indexiert');
});

test('DELETE entfernt den Termin aus dem Index (ad-Trigger)', () => {
  db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(dinner);
  assert(search('Oma').length === 0, 'gelöschter Termin weiterhin im Index');
});

test('leere/kurze Query liefert keine Treffer', () => {
  assert(search('').length === 0, 'leere Query sollte nichts liefern');
  assert(buildMatchQuery('') === null, 'buildMatchQuery leer → null');
});

test('Kalender-Suche löst einen verschobenen FTS-Treffer gegen den aktuellen Master auf', () => {
  const masterId = db.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, recurrence_rule, created_by)
    VALUES ('Search master', 'Current inherited search text', '2030-06-01T09:00:00',
            '2030-06-01T10:00:00', 0, 'FREQ=DAILY;COUNT=3', ?)
  `).run(uid).lastInsertRowid;
  const childId = db.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, recurrence_parent_id,
       recurrence_id, overridden_fields, created_by)
    VALUES ('Search override Qzxcalendar', 'Stale inherited search text',
            '2030-06-10T11:00:00', '2030-06-10T12:00:00', 1, ?, '2030-06-01',
            '["title","start_datetime","end_datetime"]', ?)
  `).run(masterId, uid).lastInsertRowid;
  db.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date)
    VALUES (?, '2030-06-01')
  `).run(masterId);

  const match = buildMatchQuery('Qzxcalendar');
  const rows = db.prepare(`
    SELECT e.*
    FROM search_index s
    JOIN calendar_events e ON e.id = s.entity_id
    WHERE s.entity = 'event' AND s.search_index MATCH ?
  `).all(match);
  const result = resolveEventSearchRows(db, rows, '2030-06-01', '2032-06-01');

  assert(result.length === 1, `erwartet 1 Treffer, erhielt ${result.length}`);
  assert(result[0].id === Number(childId), 'konkrete Child-ID fehlt');
  assert(result[0].description === 'Current inherited search text', 'Beschreibung muss vom Master erben');
  assert(result[0].all_day === 0, 'unmarkiertes all_day muss vom Master erben');
  assert(result[0].start_datetime === '2030-06-10T11:00:00', 'verschobener Start fehlt');
  assert(result[0].series_id === Number(masterId), 'Serien-ID fehlt');
  assert(result[0].recurrence_id === '2030-06-01', 'Original-Slot fehlt');
});

test('vererbter Child-Text dupliziert den Master nicht, expliziter Titel bleibt auffindbar', () => {
  const masterId = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, recurrence_rule, created_by)
    VALUES ('Qzxshared series', '2031-01-01T09:00:00', 'FREQ=DAILY;COUNT=4', ?)
  `).run(uid).lastInsertRowid;
  for (const [slot, start] of [
    ['2031-01-02', '2031-01-02T11:00:00'],
    ['2031-01-03', '2031-01-03T11:00:00'],
  ]) {
    db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, recurrence_parent_id, recurrence_id, overridden_fields, created_by)
      VALUES ('Qzxshared series', ?, ?, ?, '["start_datetime"]', ?)
    `).run(start, masterId, slot, uid);
  }
  const titledChild = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, recurrence_parent_id, recurrence_id, overridden_fields, created_by)
    VALUES ('Qzxexplicit child', '2031-01-04T11:00:00', ?, '2031-01-04',
            '["title","start_datetime"]', ?)
  `).run(masterId, uid).lastInsertRowid;

  const shared = search('Qzxshared');
  assert(shared.length === 1 && shared[0].id === Number(masterId),
    `sdílený zděděný titul má vrátit jen master, přišlo ${shared.length}`);
  const explicit = search('Qzxexplicit');
  assert(explicit.length === 1 && explicit[0].id === Number(titledChild),
    'explicitně změněný child titul musí zůstat dohledatelný');
});

test('JSON-escaped override field names remain searchable after insert, update and backfill', () => {
  const masterId = addEvent({ title: 'Escaped fields master', start: '2032-01-01T09:00:00' });
  const cases = [
    ['title', '["ti\\u0074le"]', 'Qzxescapedtitle'],
    ['description', '["descri\\u0070tion"]', 'Qzxescapeddescription'],
    ['location', '["loca\\u0074ion"]', 'Qzxescapedlocation'],
  ];
  for (const [index, [field, metadata, keyword]] of cases.entries()) {
    const childId = db.prepare(`
      INSERT INTO calendar_events
        (title, description, location, start_datetime, recurrence_parent_id,
         recurrence_id, overridden_fields, created_by)
      VALUES (?, ?, ?, '2032-01-02T11:00:00', ?, ?, ?, ?)
    `).run(field === 'title' ? keyword : 'Inherited title',
      field === 'description' ? keyword : null, field === 'location' ? keyword : null,
      masterId, `2032-01-0${index + 2}`, metadata, uid).lastInsertRowid;
    assert(search(keyword).some(({ id }) => id === Number(childId)), `${field}: escaped INSERT value is missing`);
    db.prepare(`UPDATE calendar_events SET ${field} = ? WHERE id = ?`).run(`Updated${keyword}`, childId);
    assert(search(keyword).length === 0, `${field}: stale INSERT value remains indexed`);
    assert(search(`Updated${keyword}`).some(({ id }) => id === Number(childId)), `${field}: escaped UPDATE value is missing`);
  }
  const migration = MIGRATIONS_SQL[194];
  db.exec(migration.slice(migration.lastIndexOf("DELETE FROM search_index WHERE entity = 'event';")));
  for (const [field, , keyword] of cases) {
    assert(search(`Updated${keyword}`).length === 1, `${field}: escaped backfill value is missing`);
  }
});

test('invalid or non-array override metadata neither aborts FTS writes nor indexes inherited text', () => {
  const masterId = addEvent({ title: 'Malformed fields master', start: '2033-01-01T09:00:00' });
  const metadataCases = [null, '', '[broken', '["title"', '{"field":"title"}', '"title"'];
  for (const [index, metadata] of metadataCases.entries()) {
    const childId = db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, recurrence_parent_id, recurrence_id, overridden_fields, created_by)
      VALUES ('Qzxinvalidmetadata', '2033-01-02T11:00:00', ?, ?, ?, ?)
    `).run(masterId, `2033-01-0${index + 2}`, metadata, uid).lastInsertRowid;
    db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?').run('Qzxinvalidupdated', childId);
  }
  assert(search('Qzxinvalidmetadata').length === 0, 'invalid metadata indexed an inherited INSERT value');
  assert(search('Qzxinvalidupdated').length === 0, 'invalid metadata indexed an inherited UPDATE value');
  const migration = MIGRATIONS_SQL[194];
  db.exec(migration.slice(migration.lastIndexOf("DELETE FROM search_index WHERE entity = 'event';")));
  assert(search('Qzxinvalidupdated').length === 0, 'invalid metadata indexed inherited text during backfill');
});

console.log(`\n[Calendar-Search-Test] ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed === 0 ? 0 : 1);
