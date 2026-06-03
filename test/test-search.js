/**
 * Modul: Such-Test (FTS5)
 * Zweck: Validiert die FTS5-Volltextsuche (Migration 44) und runSearch().
 *        Baut das Schema mit node:sqlite, prüft Migration + Trigger + Suchlogik.
 * Ausführen: node --experimental-sqlite test/test-search.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { runSearch, buildMatchQuery } from '../server/services/search.js';

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
// Migration 44: FTS5 index + sync triggers. Must apply cleanly.
db.exec(MIGRATIONS_SQL[44]);

console.log('\n[Search-Test] FTS5-Volltextsuche\n');

const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();
const uid = u1.lastInsertRowid;
const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('other', 'Other', 'x', 'member')`).run();
const otherUid = u2.lastInsertRowid;

// Seed rows AFTER migration so AFTER INSERT triggers populate the index.
db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
  VALUES ('Buy birthday cake', 'chocolate sponge', 'high', 'open', ?)`).run(uid);
db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
  VALUES ('Mow the lawn', 'garden chores', 'low', 'open', ?)`).run(uid);
db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
  VALUES ('Secret cake plan', 'hidden', 'low', 'open', ?)`).run(otherUid);

const list = db.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('Groceries', ?)`).run(uid);
db.prepare(`INSERT INTO shopping_items (list_id, name) VALUES (?, 'cake mix')`).run(list.lastInsertRowid);

db.prepare(`INSERT INTO notes (title, content, created_by) VALUES ('Party', 'order the cake early', ?)`).run(uid);
db.prepare(`INSERT INTO contacts (name, phone, email) VALUES ('Cake Bakery', '555-1', 'hi@cake.test')`).run();
db.prepare(`INSERT INTO calendar_events (title, description, start_datetime, created_by)
  VALUES ('Cake tasting', 'pick a flavor', '2030-01-01T10:00:00Z', ?)`).run(uid);

test('Migration 44 legt FTS5-Tabelle und Trigger an, Backfill leer (Seed danach)', () => {
  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'search_index'`).get();
  assert(tbl, 'search_index sollte existieren');
  const triggers = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_search_%'`).get();
  assert(triggers.n === 15, `Erwartet 15 Trigger, erhalten ${triggers.n}`);
});

test('buildMatchQuery erzeugt sichere Präfix-Phrasen, ignoriert Sonderzeichen', () => {
  assert(buildMatchQuery('cake') === '"cake"*', 'Einzeltoken als Präfix-Phrase');
  assert(buildMatchQuery('  ') === null, 'Leerzeichen -> null');
  assert(buildMatchQuery('a"b') === '"ab"*', 'Anführungszeichen/Sonderzeichen werden gesäubert');
  assert(buildMatchQuery('order the cake') === '"order"* AND "the"* AND "cake"*', 'Mehrere Tokens via AND');
});

test('Suche findet Aufgabe über Titel-Treffer (FTS MATCH)', () => {
  const r = runSearch(db, 'birthday', uid);
  assert(r.tasks.length === 1, `Erwartet 1 Task, erhalten ${r.tasks.length}`);
  assert(r.tasks[0].title === 'Buy birthday cake', 'Korrekte Aufgabe');
});

test('Suche respektiert Besitzer-Filter bei Aufgaben', () => {
  const r = runSearch(db, 'cake', uid);
  const titles = r.tasks.map((t) => t.title);
  assert(titles.includes('Buy birthday cake'), 'Eigene Aufgabe gefunden');
  assert(!titles.includes('Secret cake plan'), 'Fremde Aufgabe ausgeschlossen');
});

test('Suche deckt alle Entitäten ab', () => {
  const r = runSearch(db, 'cake', uid);
  assert(r.items.some((i) => i.title === 'cake mix'), 'Einkaufsartikel gefunden');
  assert(r.notes.some((n) => n.content.includes('cake')), 'Notiz gefunden');
  assert(r.contacts.some((c) => c.title === 'Cake Bakery'), 'Kontakt gefunden');
  assert(r.events.some((e) => e.title === 'Cake tasting'), 'Termin gefunden');
});

test('Präfix-Treffer funktionieren (Teilwort)', () => {
  const r = runSearch(db, 'choc', uid);
  assert(r.tasks.some((t) => t.title === 'Buy birthday cake'), 'Beschreibung "chocolate" via Präfix');
});

test('UPDATE-Trigger hält den Index synchron', () => {
  const t = db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
    VALUES ('Renamewip', 'tmp', 'low', 'open', ?)`).run(uid);
  db.prepare(`UPDATE tasks SET title = 'Plumbing fix' WHERE id = ?`).run(t.lastInsertRowid);
  const before = runSearch(db, 'Renamewip', uid);
  assert(before.tasks.length === 0, 'Alter Titel nicht mehr im Index');
  const after = runSearch(db, 'Plumbing', uid);
  assert(after.tasks.some((x) => x.id === Number(t.lastInsertRowid)), 'Neuer Titel im Index');
});

test('DELETE-Trigger entfernt aus dem Index', () => {
  const t = db.prepare(`INSERT INTO tasks (title, priority, status, created_by)
    VALUES ('Throwaway zebra', 'low', 'open', ?)`).run(uid);
  assert(runSearch(db, 'zebra', uid).tasks.length === 1, 'Vorher gefunden');
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(t.lastInsertRowid);
  assert(runSearch(db, 'zebra', uid).tasks.length === 0, 'Nachher nicht mehr gefunden');
});

test('Leere/kurze Query liefert leere Ergebnisse', () => {
  const r = runSearch(db, '', uid);
  assert(r.tasks.length === 0 && r.events.length === 0 && r.notes.length === 0
    && r.contacts.length === 0 && r.items.length === 0, 'Alles leer');
});

console.log(`\n[Search-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
