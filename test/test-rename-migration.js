/**
 * Test-Suite: Legacy-DB-Migration oikos.db → yuvomi.db (Boot-Zeit-Auto-Rename).
 *
 * Deckt den Resolver + die einmalige Dateimigration in server/db.js ab. Jedes
 * Szenario lädt eine frische db.js-Instanz (dynamischer Import mit Cache-Busting-
 * Query), nachdem process.env.DB_PATH gesetzt wurde — denn der effektive Pfad
 * wird beim Modul-Load aus der Env abgeleitet.
 *
 * Lauf: node --experimental-sqlite --test test/test-rename-migration.js
 *   (bzw. npm run test:rename-migration)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

let scenarioCounter = 0;

// Frische db.js-Instanz mit dem gegebenen DB_PATH laden und initialisieren.
async function bootDb(dbPath) {
  if (dbPath === null) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = dbPath;
  }
  const mod = await import(`../server/db.js?scenario=${++scenarioCounter}`);
  mod.init();
  return mod;
}

// Eine minimale, gültige SQLite-Datei mit Marker-Zeile als „Legacy-oikos.db" erzeugen.
function seedLegacyDb(filePath, marker) {
  const seed = new Database(filePath);
  seed.exec('CREATE TABLE rename_marker (note TEXT)');
  seed.prepare('INSERT INTO rename_marker (note) VALUES (?)').run(marker);
  seed.close();
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'yuvomi-rename-'));
}

test('Legacy-Default: DB_PATH=…/oikos.db wird nach yuvomi.db migriert (Daten erhalten)', async () => {
  const dir = tmpDir();
  const legacy = join(dir, 'oikos.db');
  const target = join(dir, 'yuvomi.db');
  seedLegacyDb(legacy, 'legacy-default');

  const mod = await bootDb(legacy);

  assert.ok(existsSync(target), 'yuvomi.db muss nach der Migration existieren');
  assert.ok(!existsSync(legacy), 'oikos.db darf nach der Migration nicht mehr existieren');
  assert.equal(mod.getPath(), target, 'getPath() muss den neuen Pfad liefern');
  const row = mod.get().prepare('SELECT note FROM rename_marker').get();
  assert.equal(row.note, 'legacy-default', 'Marker-Daten müssen erhalten bleiben');
});

test('Compose-Update-Falle: DB_PATH=…/yuvomi.db migriert vorhandene oikos.db trotzdem', async () => {
  const dir = tmpDir();
  const legacy = join(dir, 'oikos.db');
  const target = join(dir, 'yuvomi.db');
  seedLegacyDb(legacy, 'compose-update');

  // Nutzer hat seine Compose-Datei auf den neuen Default aktualisiert, Daten
  // liegen aber noch in oikos.db → Migration muss greifen.
  const mod = await bootDb(target);

  assert.ok(existsSync(target), 'yuvomi.db muss existieren');
  assert.ok(!existsSync(legacy), 'oikos.db muss migriert worden sein');
  const row = mod.get().prepare('SELECT note FROM rename_marker').get();
  assert.equal(row.note, 'compose-update');
});

test('Custom-Pfad: DB_PATH=…/familie.db wird respektiert, oikos.db bleibt unangetastet', async () => {
  const dir = tmpDir();
  const legacy = join(dir, 'oikos.db');
  const custom = join(dir, 'familie.db');
  seedLegacyDb(legacy, 'should-stay');

  const mod = await bootDb(custom);

  assert.equal(mod.getPath(), custom, 'Custom-Pfad muss verwendet werden');
  assert.ok(existsSync(custom), 'familie.db muss angelegt sein');
  assert.ok(existsSync(legacy), 'oikos.db darf NICHT migriert werden (Custom-Layout)');
  // familie.db ist eine frische DB ohne Marker-Tabelle.
  const marker = mod.get()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rename_marker'")
    .get();
  assert.equal(marker, undefined, 'Custom-DB darf die oikos-Marker-Daten nicht enthalten');
});

test('Doppelzustand: existieren beide, gewinnt yuvomi.db und oikos.db bleibt liegen', async () => {
  const dir = tmpDir();
  const legacy = join(dir, 'oikos.db');
  const target = join(dir, 'yuvomi.db');
  seedLegacyDb(legacy, 'legacy-loser');
  seedLegacyDb(target, 'target-winner');

  const mod = await bootDb(target);

  assert.ok(existsSync(legacy), 'oikos.db muss im Doppelzustand erhalten bleiben');
  const row = mod.get().prepare('SELECT note FROM rename_marker').get();
  assert.equal(row.note, 'target-winner', 'Die bestehende yuvomi.db gewinnt');
});

test('Frische Installation: kein Legacy-File → yuvomi.db wird neu angelegt', async () => {
  const dir = tmpDir();
  const target = join(dir, 'yuvomi.db');

  const mod = await bootDb(target);

  assert.ok(existsSync(target), 'yuvomi.db muss frisch angelegt werden');
  assert.ok(!existsSync(join(dir, 'oikos.db')), 'keine oikos.db bei frischer Installation');
});

test('Migration ist idempotent: zweiter Boot mit bereits migrierter yuvomi.db ist ein No-Op', async () => {
  const dir = tmpDir();
  const legacy = join(dir, 'oikos.db');
  const target = join(dir, 'yuvomi.db');
  seedLegacyDb(legacy, 'idempotent');

  await bootDb(legacy);              // erster Boot migriert
  assert.ok(!existsSync(legacy));

  const mod2 = await bootDb(target); // zweiter Boot: nichts zu migrieren
  const row = mod2.get().prepare('SELECT note FROM rename_marker').get();
  assert.equal(row.note, 'idempotent', 'Daten bleiben über mehrere Boots stabil');
});
