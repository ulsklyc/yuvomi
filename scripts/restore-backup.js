#!/usr/bin/env node

/**
 * Restore an Yuvomi database backup from the CLI.
 *
 * Usage:
 *   node --import dotenv/config scripts/restore-backup.js /path/to/yuvomi-backup.db
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import 'dotenv/config';

const backupPath = process.argv[2];

if (!backupPath) {
  console.error('Usage: node --import dotenv/config scripts/restore-backup.js /path/to/yuvomi-backup.db');
  process.exit(1);
}

const resolved = path.resolve(backupPath);

// Handschlag mit server/db.js, VOR dessen Import: dieses Skript ersetzt die
// Datei unter DB_PATH, also ist eine leere Datei dort (#1282) kein Grund, beim
// Import abzubrechen - sie ist genau das, was ein Restore reparieren soll. Nur
// dieser eine Fall wird dadurch zurückgestellt, siehe Auto-Init am Ende von
// db.js; eine gesunde Datenbank öffnet der Import weiter wie bisher.
globalThis[Symbol.for('yuvomi.db.restoreTarget')] = true;

try {
  // Dynamisch und innerhalb des try: jeder Abbruch beim Öffnen der Datenbank
  // (falscher Key, unlesbare Datei, ...) endet als `Restore failed: ...`
  // statt als ungefangene Ausnahme mit Stacktrace.
  const { getPath, restoreFromFile } = await import('../server/db.js');
  await fs.access(resolved);
  const result = await restoreFromFile(resolved);
  console.log(`Restored ${resolved} into ${getPath()}. Schema v${result.schemaVersion}.`);
  if (result.rollbackPath) {
    console.log(`Previous database copy saved at ${result.rollbackPath}.`);
  }
  if (result.keptJournalPath) {
    console.log(
      `A write-ahead log with data lay next to the empty database file. It belongs to the database `
      + `that was there before and can hold changes that exist nowhere else, so it was not deleted: `
      + `it is kept at ${result.keptJournalPath} (with its -shm next to it, if there was one). `
      + `The name is deliberate: under the usual -wal name next to the empty copy, SQLite would `
      + `discard the log the first time the copy is opened.`
    );
  }
  process.exit(0);
} catch (err) {
  console.error(`Restore failed: ${err?.message || err}`);
  process.exit(1);
}
