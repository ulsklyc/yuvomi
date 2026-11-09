/**
 * Test: Inventory ships disabled by default (Migration v145)
 * Zweck: Inventory ist das erste Modul, das abgeschaltet ausgeliefert wird
 *        (Diskussion #696 - jedes Modul kostet jeden Haushalt dauerhaft einen
 *        Navigationseintrag). Zwei Faelle muessen stimmen:
 *        (1) Neuinstallation: es gibt keinen Seed-Pfad ausser den Migrationen
 *            selbst, migrate() faehrt auf einer frischen DB die ganze Liste.
 *        (2) Bestandshaushalt: der Wert ist ein JSON-Array in einer
 *            sync_config-Zeile und muss gemergt werden - ein blindes Ersetzen
 *            wuerde bereits abgeschaltete Module wieder einschalten.
 * Ausführen: node --test test/test-inventory-default-off-migration.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const dbmod = await import('../server/db.js');
const db = dbmod.get();

const migration145 = dbmod.MIGRATIONS.find((m) => m.version === 145);

function readDisabled(conn) {
  const row = conn.prepare("SELECT value FROM sync_config WHERE key = 'disabled_modules'").get();
  return row ? JSON.parse(row.value) : null;
}

// Eine Bestands-DB nachbauen heisst hier: nur die sync_config-Tabelle, mehr
// beruehrt die Migration nicht. Der Import oben hat die echte Migration auf
// der frischen DB schon laufen lassen, fuer den Merge-Fall brauchen wir eine
// eigene Instanz mit vorbelegtem Wert.
function householdWith(value) {
  const conn = new DatabaseSync(':memory:');
  conn.exec(`
    CREATE TABLE sync_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  if (value !== undefined) {
    conn.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?)").run(value);
  }
  return conn;
}

test('Neuinstallation startet mit abgeschaltetem Inventory', () => {
  // Isoliert wie die beiden Faelle darunter: der globale `db` durchlaeuft
  // ALLE Migrationen, nicht nur 145, und traegt seit Migration 161 zusaetzlich
  // 'schedule' im selben Feld (dasselbe Muster, ein zweites Modul). Eine
  // Zusicherung gegen den globalen Singleton waere bei jedem weiteren
  // Default-Off-Modul erneut faellig - migration145.up() auf einer isolierten
  // Verbindung zeigt stattdessen genau das, was DIESE Migration beitraegt.
  const conn = householdWith();
  migration145.up(conn);
  assert.deepEqual(readDisabled(conn), ['inventory']);
});

test('Bestandshaushalt behaelt seine eigenen Abschaltungen', () => {
  const conn = householdWith(JSON.stringify(['notes', 'rewards']));
  migration145.up(conn);

  const disabled = readDisabled(conn);
  assert.deepEqual(disabled.slice().sort(), ['inventory', 'notes', 'rewards']);
});

test('Haushalt ohne Zeile bekommt sie angelegt', () => {
  const conn = householdWith(undefined);
  migration145.up(conn);
  assert.deepEqual(readDisabled(conn), ['inventory']);
});

test('Kaputter oder fremdformatiger Wert legt die Migration nicht lahm', () => {
  for (const broken of ['{nicht json', '"kein array"', '42', 'null']) {
    const conn = householdWith(broken);
    migration145.up(conn);
    assert.deepEqual(readDisabled(conn), ['inventory'], `Wert ${broken} muss ersetzt werden`);
  }
});

test('Nicht-String-Eintraege werden aussortiert statt mitgeschleppt', () => {
  const conn = householdWith(JSON.stringify(['notes', 42, null, { a: 1 }]));
  migration145.up(conn);
  assert.deepEqual(readDisabled(conn), ['notes', 'inventory']);
});

test('Zweiter Lauf fuegt inventory kein zweites Mal hinzu', () => {
  // Die Migration laeuft dank schema_migrations genau einmal; die Idempotenz
  // ist trotzdem billig und schuetzt beim Restore aus inkonsistentem Backup.
  const conn = householdWith(JSON.stringify(['notes']));
  migration145.up(conn);
  migration145.up(conn);
  assert.deepEqual(readDisabled(conn), ['notes', 'inventory']);
});

test('inventory ist ein gueltiger Slug fuer die Lese-/Schreibseite', async () => {
  // parseDisabledModules filtert gegen TOGGLEABLE_MODULES - stuende inventory
  // dort nicht, waere der von der Migration geschriebene Wert wirkungslos.
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../server/routes/preferences.js', import.meta.url), 'utf8'));
  const list = source.match(/const TOGGLEABLE_MODULES = \[([\s\S]*?)\];/)?.[1];
  assert.ok(list, 'TOGGLEABLE_MODULES nicht gefunden');
  assert.match(list, /'inventory'/);
});
