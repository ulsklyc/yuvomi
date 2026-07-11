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
import { buildMatchQuery } from '../server/services/search.js';

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

console.log(`\n[Calendar-Search-Test] ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed === 0 ? 0 : 1);
