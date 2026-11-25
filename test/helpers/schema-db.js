/**
 * Modul: Test-Schema aus den echten Quellen (test schema database)
 * Zweck: Suiten auf node:sqlite bekommen ihr Schema aus der ausgelieferten
 *        Baseline (server/migrations/baseline.sql) plus den Migrationen
 *        darueber - also genau den Stand, den eine neue Installation hat.
 *        Eine Suite, die einen Altzustand braucht, faehrt die ECHTEN
 *        Migrationen bis Version K von Null, legt ihre alten Zeilen an und
 *        faehrt dann mit migrateTo() weiter. Eine Handkopie des Schemas gibt
 *        es nicht mehr.
 *
 * Gedeckt durch test:schema-baseline (Treiber-Matrix: dieselbe Funktion
 * migrateOnNodeSqlite faehrt dort alle Migrationen von Null und die Baseline
 * samt Migrationen darueber) und durch jede Suite, die hier ihr Schema holt.
 * Abhängigkeiten: node:assert, node:sqlite, server/db/baseline.ts,
 *                 server/migrations/index.ts
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { applyBaseline, loadBaseline } from '../../server/db/baseline.ts';
import { MIGRATIONS } from '../../server/migrations/index.ts';

/**
 * @typedef {(typeof MIGRATIONS)[number] & { afterUp?: Function, foreignKeysOff?: boolean }} Migration
 */

/**
 * Migrationen auf node:sqlite fahren. DatabaseSync hat weder `transaction()`
 * noch `pragma()`, die migrate() braucht; hier laeuft deshalb jede Migration
 * Anweisung fuer Anweisung ohne Transaktion, sonst wie in migrate(): `up`,
 * `afterUp`, bei `foreignKeysOff` die Fremdschluessel aus und danach wieder an
 * mit Pruefung, dann die Buchung. Schon gebuchte Versionen werden uebersprungen.
 * @param {DatabaseSync} database @param {Migration[]} migrations
 */
export function migrateOnNodeSqlite(database, migrations) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    if (migration.foreignKeysOff) database.exec('PRAGMA foreign_keys = OFF');
    if (typeof migration.up === 'function') migration.up(/** @type {any} */ (database));
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    if (migration.foreignKeysOff) {
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [], `Migration ${migration.version}`);
      database.exec('PRAGMA foreign_keys = ON');
    }
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(migration.version, migration.description);
  }
}

/**
 * Die echten Migrationen bis einschliesslich `version`. Eine Nummer, die es
 * nicht gibt, wirft: ein Tippfehler darf keinen anderen Stand liefern.
 * @param {number} version @returns {Migration[]}
 */
function migrationsUpTo(version) {
  assert.ok(MIGRATIONS.some((m) => m.version === version), `Migration ${version} gibt es nicht`);
  return MIGRATIONS.filter((m) => m.version <= version);
}

/**
 * Das heutige Schema in eine LEERE Datenbank, die die Suite selbst angelegt
 * hat: Baseline, dann die Migrationen ueber ihrer Version.
 * @param {DatabaseSync} database
 */
export function applySchema(database) {
  applyBaseline(database, loadBaseline());
  migrateOnNodeSqlite(database, MIGRATIONS);
}

/**
 * Neue In-Memory-Datenbank auf node:sqlite mit eingeschalteten
 * Fremdschluesseln.
 *   openSchemaDb()            -> heutiges Schema (Baseline + Migrationen darueber)
 *   openSchemaDb({ upTo: K }) -> Altzustand: die echten Migrationen 1 bis K
 *                                von Null, ohne Baseline
 * @param {{ upTo?: number }} [options] @returns {DatabaseSync}
 */
export function openSchemaDb({ upTo } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  if (upTo === undefined) applySchema(database);
  else migrateOnNodeSqlite(database, migrationsUpTo(upTo));
  return database;
}

/**
 * Eine mit openSchemaDb({ upTo: K }) geoeffnete Datenbank mit den echten
 * Migrationen bis einschliesslich `version` weiterfahren.
 * @param {DatabaseSync} database @param {number} version
 */
export function migrateTo(database, version) {
  migrateOnNodeSqlite(database, migrationsUpTo(version));
}
