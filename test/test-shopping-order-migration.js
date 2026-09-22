/**
 * Test: Handsortierung der Einkaufsliste (Migration v133, #678)
 * Zweck: Die Migration fügt shopping_items.sort_order hinzu und muss dabei zwei
 *        Dinge leisten, die eine frische DB nicht prüfen kann: den BESTAND so
 *        durchnummerieren, dass die heute sichtbare Reihenfolge erhalten bleibt
 *        (sonst würfelt ein Update jede gewachsene Liste durcheinander), und
 *        neue Zeilen per Trigger ans Ende ihrer Kategorie stellen - auch wenn
 *        sie an der Route vorbei eingefügt werden, wie es sechs Module tun.
 *        Geprüft gegen eine eigens aufgebaute Vor-v133-DB mit Daten.
 * Ausführen: node --test test/test-shopping-order-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

// DB_PATH vor dem Import auf eine Wegwerf-Datei setzen: db.js initialisiert beim
// Modul-Load (und migriert dabei). Geprüft wird hier nur die exportierte
// v133-SQL gegen eine selbst aufgebaute Vor-v133-DB.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-sortmig-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V133 = MIGRATIONS.find((m) => m.version === 133);

/**
 * shopping_items im Zustand vor v133: keine sort_order, Reihenfolge ergibt sich
 * aus created_at. Zwei Listen und zwei Kategorien, damit sichtbar wird, dass die
 * Nummerierung je (Liste, Kategorie) läuft und nicht global.
 */
function seedPreV133() {
  const db = new Database(join(tempDir('yuvomi-sortmig-'), 'db.sqlite'));
  db.exec(`
    CREATE TABLE shopping_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id    INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      category   TEXT    NOT NULL DEFAULT 'Sonstiges',
      is_checked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL
    );
  `);

  // Absichtlich NICHT in Anzeigereihenfolge eingefügt: die id-Reihenfolge und
  // die created_at-Reihenfolge laufen auseinander. Nur so zeigt der Test, dass
  // der Backfill nach created_at nummeriert und nicht nach Einfügereihenfolge.
  const ins = db.prepare(
    'INSERT INTO shopping_items (list_id, name, category, created_at) VALUES (?, ?, ?, ?)'
  );
  ins.run(1, 'Banane',  'Obst',   '2026-01-03T10:00:00Z');
  ins.run(1, 'Apfel',   'Obst',   '2026-01-01T10:00:00Z');
  ins.run(1, 'Kirsche', 'Obst',   '2026-01-02T10:00:00Z');
  ins.run(1, 'Brot',    'Backen', '2026-01-05T10:00:00Z');
  ins.run(2, 'Milch',   'Obst',   '2026-01-04T10:00:00Z');   // andere Liste, gleiche Kategorie
  return db;
}

const reihenfolge = (db, listId, category) => db.prepare(`
  SELECT name FROM shopping_items
   WHERE list_id = ? AND category = ?
   ORDER BY sort_order ASC, created_at ASC
`).all(listId, category).map((r) => r.name);

test('v133: Backfill erhält die bisher sichtbare Reihenfolge (nach created_at)', () => {
  const db = seedPreV133();
  db.exec(V133.up);

  assert.deepEqual(reihenfolge(db, 1, 'Obst'), ['Apfel', 'Kirsche', 'Banane'],
    'Vor v133 entschied created_at - genau diese Folge muss die Nummerierung abbilden.');
  db.close();
});

test('v133: nummeriert je (Liste, Kategorie), nicht global', () => {
  const db = seedPreV133();
  db.exec(V133.up);

  const rang = (name) => db.prepare('SELECT sort_order FROM shopping_items WHERE name = ?').get(name).sort_order;
  // Jede Gruppe beginnt bei 1 - sonst wären die Ränge zweier Listen vergleichbar,
  // obwohl sie nie nebeneinander stehen.
  assert.equal(rang('Apfel'), 1);
  assert.equal(rang('Brot'),  1, 'eigene Kategorie, eigene Zählung');
  assert.equal(rang('Milch'), 1, 'eigene Liste, eigene Zählung');
  db.close();
});

test('v133: kein Bestandsrang bleibt auf 0 (die Marke des Triggers)', () => {
  const db = seedPreV133();
  db.exec(V133.up);

  const nullen = db.prepare('SELECT COUNT(*) AS c FROM shopping_items WHERE sort_order = 0').get().c;
  assert.equal(nullen, 0,
    'sort_order 0 heißt "noch nicht eingeordnet" und lässt den Trigger zugreifen. '
    + 'Bliebe der Bestand darauf stehen, würde ihn der nächste Insert umnummerieren.');
  db.close();
});

test('v133: Trigger stellt neue Zeilen ans Ende ihrer Kategorie', () => {
  const db = seedPreV133();
  db.exec(V133.up);

  // So fügen meals.js, recipes.js, housekeeping.js, mcp/tools.js und der
  // CalDAV-Sync ein: ohne sort_order, an jeder Route vorbei.
  db.prepare(`INSERT INTO shopping_items (list_id, name, category, created_at)
              VALUES (1, 'Melone', 'Obst', '2026-02-01T10:00:00Z')`).run();
  assert.deepEqual(reihenfolge(db, 1, 'Obst'), ['Apfel', 'Kirsche', 'Banane', 'Melone']);

  // Und die Nachbarkategorie bleibt davon unberührt.
  assert.deepEqual(reihenfolge(db, 1, 'Backen'), ['Brot']);
  db.close();
});

test('v133: Trigger zählt je Liste, nicht über alle', () => {
  const db = seedPreV133();
  db.exec(V133.up);

  // Liste 2 hat in 'Obst' nur einen Artikel (Rang 1). Ein neuer dort muss Rang 2
  // bekommen - nicht den Rang hinter Liste 1, deren 'Obst' bis 3 zählt.
  db.prepare(`INSERT INTO shopping_items (list_id, name, category, created_at)
              VALUES (2, 'Joghurt', 'Obst', '2026-02-01T10:00:00Z')`).run();
  assert.equal(
    db.prepare("SELECT sort_order FROM shopping_items WHERE name = 'Joghurt'").get().sort_order, 2);
  db.close();
});

test('v133: ein mitgegebener Rang überlebt den Trigger', () => {
  const db = seedPreV133();
  db.exec(V133.up);

  // Der Trigger greift nur bei sort_order = 0. Wer selbst einordnet - etwa ein
  // späterer Import, der eine Reihenfolge mitbringt - behält sie.
  db.prepare(`INSERT INTO shopping_items (list_id, name, category, sort_order, created_at)
              VALUES (1, 'Zwischenstop', 'Obst', 2, '2026-02-01T10:00:00Z')`).run();
  assert.equal(
    db.prepare("SELECT sort_order FROM shopping_items WHERE name = 'Zwischenstop'").get().sort_order, 2);
  db.close();
});
