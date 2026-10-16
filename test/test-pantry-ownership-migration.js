/**
 * Test: Migration v109 - Vorrat bleibt Haushaltsbesitz (#596 Follow-up)
 * Zweck: v108 gab `pantry_items.created_by` ein ON DELETE CASCADE. Der Router
 *        behandelt den Vorrat aber ausdrücklich als Haushaltsbesitz (kein
 *        Eigentümer-Gate) - mit CASCADE hätte das Löschen eines Mitglieds den
 *        Bestand des ganzen Haushalts mitgerissen. v109 baut die Tabelle auf
 *        nullable + ON DELETE SET NULL um.
 *
 *        Ein Tabellen-Rebuild ist die riskanteste Migrationsform (Daten kopieren,
 *        Indizes und Trigger neu anlegen). Dieser Test belegt beides: dass der
 *        Bestand die Migration übersteht und dass das Löschen eines Nutzers ihn
 *        danach nicht mehr vernichtet.
 * Ausführen: node --experimental-sqlite --test test/test-pantry-ownership-migration.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const db = dbmod.get();

const OWNER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('vorratsleger', 'Vorratsleger', 'x', 'member')
`).run().lastInsertRowid;

const LOCATION = db.prepare(`SELECT id FROM pantry_locations WHERE name = 'Vorratsschrank'`).get().id;

test('created_by ist nullable und löscht per SET NULL, nicht per CASCADE', () => {
  const fks = db.prepare('PRAGMA foreign_key_list(pantry_items)').all();
  const createdBy = fks.find((fk) => fk.from === 'created_by');

  assert.ok(createdBy, 'created_by hat keine Fremdschlüssel-Beziehung mehr');
  assert.equal(createdBy.on_delete, 'SET NULL', 'created_by kaskadiert weiterhin');

  const column = db.prepare('PRAGMA table_info(pantry_items)').all().find((c) => c.name === 'created_by');
  assert.equal(column.notnull, 0, 'created_by ist noch NOT NULL - SET NULL könnte gar nicht greifen');
});

test('der Rebuild hat Indizes und Trigger wieder angelegt', () => {
  const indices = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'pantry_items' AND name NOT LIKE 'sqlite_%'
  `).all().map((r) => r.name).sort();
  assert.deepEqual(indices, [
    'idx_pantry_items_expires',
    'idx_pantry_items_location',
    'idx_pantry_items_name',
    // Migration 250 (#1448): the batch's product, not part of the rebuild.
    'idx_pantry_items_product',
  ]);

  const triggers = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'pantry_items'
  `).all().map((r) => r.name);
  assert.deepEqual(triggers, ['trg_pantry_items_updated_at']);
});

test('das Löschen eines Mitglieds erhält den Bestand und entkoppelt nur die Herkunft', () => {
  const itemId = db.prepare(`
    INSERT INTO pantry_items (name, quantity, unit, location_id, category, created_by)
    VALUES ('Mehl, Type 405', 2, 'kg', ?, 'Sonstiges', ?)
  `).run(LOCATION, OWNER).lastInsertRowid;

  db.prepare('DELETE FROM users WHERE id = ?').run(OWNER);

  const row = db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(itemId);
  assert.ok(row, 'der Vorratsartikel wurde mit dem Nutzer gelöscht - CASCADE ist zurück');
  assert.equal(row.quantity, 2, 'der Bestand hat sich verändert');
  assert.equal(row.created_by, null, 'die Herkunft wurde nicht entkoppelt');
  assert.equal(row.location_id, LOCATION, 'der Lagerort ging beim Rebuild verloren');
});

test('der updated_at-Trigger feuert nach dem Rebuild weiterhin', () => {
  const id = db.prepare(`
    INSERT INTO pantry_items (name, quantity, unit, category, created_at, updated_at)
    VALUES ('Zucker', 1, 'kg', 'Sonstiges', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
  `).run().lastInsertRowid;

  db.prepare('UPDATE pantry_items SET quantity = 3 WHERE id = ?').run(id);

  const row = db.prepare('SELECT updated_at FROM pantry_items WHERE id = ?').get(id);
  assert.notEqual(row.updated_at, '2020-01-01T00:00:00Z', 'updated_at wurde nicht nachgezogen');
});

test('ein Artikel ohne Ersteller lässt sich weiterhin anlegen und ändern', () => {
  // Nach SET NULL existieren herkunftslose Zeilen - der Router darf daran nicht
  // scheitern, weil er created_by nur schreibt, nie liest.
  const id = db.prepare(`
    INSERT INTO pantry_items (name, quantity, unit, category) VALUES ('Salz', 1, 'pcs', 'Sonstiges')
  `).run().lastInsertRowid;

  db.prepare('UPDATE pantry_items SET quantity = 5 WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT quantity FROM pantry_items WHERE id = ?').get(id).quantity, 5);
});
