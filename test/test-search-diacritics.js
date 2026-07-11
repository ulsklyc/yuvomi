/**
 * Modul: Diakritika-Such-Test (#471)
 * Zweck: Validiert Migration 77 — der FTS-Index (unicode61 remove_diacritics 2)
 *        findet diakritikbehaftete Treffer auch bei asciifizierter Eingabe
 *        („muller" → „Müller", „strasse"/„strase" → „Straße") und umgekehrt.
 *        Deckt Termine (Titel/Ort) und Kontakte ab; prüft den index-weiten Rebuild.
 * Ausführen: node --experimental-sqlite test/test-search-diacritics.js
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
// Prerequisite-Chain: 77 liest beim Rebuild index-weit aus allen Modul-Tabellen
// (Health v65/66, Event-location v76). Das konsolidierte Test-Schema führt
// shopping_items.notes bereits in der Basis, daher kein separates v68 nötig.
for (const v of [1, 44, 65, 66, 76, 77]) db.exec(MIGRATIONS_SQL[v]);

console.log('\n[Diacritics-Search-Test] unicode61 remove_diacritics 2 (#471)\n');

const uid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run().lastInsertRowid;

// Seeds NACH dem Rebuild → laufen durch die (unveränderten) Trigger in den neuen Index.
db.prepare(`INSERT INTO calendar_events (title, description, location, start_datetime, created_by)
  VALUES ('Zahnarzt', 'Kontrolle', 'Praxis Müller, Grünstraße 3', '2030-04-01T09:00:00Z', ?)`).run(uid);
db.prepare(`INSERT INTO contacts (name, phone, email) VALUES ('Renée Håkonsen', '555', 'r@x.test')`).run();

function search(q, entity = 'event') {
  const match = buildMatchQuery(q);
  if (!match) return [];
  return db.prepare(`
    SELECT s.entity_id AS id FROM search_index s
    WHERE s.entity = @entity AND s.search_index MATCH @match
  `).all({ match, entity });
}

test('asciifizierte Eingabe findet diakritischen Ort (muller → Müller)', () => {
  assert(search('muller').length === 1, '„muller" sollte „Müller" finden');
  assert(search('grun').length === 1, '„grun" sollte „Grünstraße" per Präfix finden');
});

test('ß↔ss-Varianten: „strasse" findet „Straße" (Query-Expansion)', () => {
  // ß wird vom Tokenizer nicht gefaltet; buildMatchQuery ergänzt die ss↔ß-Variante.
  assert(search('grunstrasse').length === 1, '„grunstrasse" sollte „Grünstraße" finden');
  // Gegenrichtung: gespeichertes „ss" per „ß"-Eingabe finden.
  const id = db.prepare(`INSERT INTO calendar_events (title, location, start_datetime, created_by)
    VALUES ('Straßenfest', 'Hauptstrasse 1', '2030-06-15T15:00:00Z', ?)`).run(uid).lastInsertRowid;
  assert(search('hauptstraße').length === 1, '„hauptstraße" sollte „Hauptstrasse" finden');
  assert(search('strassenfest').length === 1, '„strassenfest" sollte „Straßenfest" finden');
  db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
});

test('diakritische Eingabe findet weiterhin (Müller → Müller)', () => {
  assert(search('Müller').length === 1, 'exakte Eingabe muss weiter matchen');
  assert(search('Grünstraße').length === 1, 'exakte Straße muss weiter matchen');
});

test('Titel bleibt diakritik-insensitiv auffindbar', () => {
  assert(search('zahnarzt').length === 1, 'Titel-Treffer');
});

test('Kontakte sind ebenfalls gefaltet (renee → Renée, hakonsen → Håkonsen)', () => {
  assert(search('renee', 'contact').length === 1, '„renee" sollte „Renée" finden');
  assert(search('hakonsen', 'contact').length === 1, '„hakonsen" sollte „Håkonsen" finden');
});

test('Trigger halten den neuen Index synchron (INSERT/UPDATE/DELETE)', () => {
  const id = db.prepare(`INSERT INTO calendar_events (title, location, start_datetime, created_by)
    VALUES ('Café-Termin', 'Bäckerei', '2030-05-01T10:00:00Z', ?)`).run(uid).lastInsertRowid;
  assert(search('cafe').length === 1, 'neuer Termin diakritik-insensitiv auffindbar');
  db.prepare(`UPDATE calendar_events SET location = 'Konditorei Wörner' WHERE id = ?`).run(id);
  assert(search('worner').length === 1, 'Update reindexiert diakritik-insensitiv');
  db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
  assert(search('worner').length === 0, 'Delete entfernt aus Index');
});

console.log(`\n[Diacritics-Search-Test] ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed === 0 ? 0 : 1);
