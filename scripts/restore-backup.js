#!/usr/bin/env node

/**
 * Restore an Yuvomi database backup from the CLI.
 *
 * Usage:
 *   node --import dotenv/config scripts/restore-backup.js /path/to/yuvomi-backup.db
 *
 * Backup from ANOTHER installation (#1267): pass that installation's
 * DB_ENCRYPTION_KEY on stdin - never as an argument, where it would show up in
 * the process list and the shell history. The backup is re-encrypted with this
 * installation's own key; the old key is not stored anywhere.
 *   IFS= read -rs OLDKEY; printf %s "$OLDKEY" | node scripts/restore-backup.js /path/to/backup.db --backup-key-stdin; unset OLDKEY
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import 'dotenv/config';

const args = process.argv.slice(2);
const keyFromStdin = args.includes('--backup-key-stdin');
const backupPath = args.find((arg) => !arg.startsWith('--'));

if (!backupPath) {
  console.error('Usage: node --import dotenv/config scripts/restore-backup.js /path/to/yuvomi-backup.db [--backup-key-stdin]');
  process.exit(1);
}

/** Alles von stdin; genau EIN abschliessender Zeilenumbruch gehoert nicht zum Schluessel. */
async function readKeyFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let bytes = Buffer.concat(chunks);
  if (bytes.at(-1) === 0x0a) bytes = bytes.subarray(0, -1);
  if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
  if (bytes.length === 0) throw new Error('--backup-key-stdin was given, but stdin carried no key.');
  return bytes;
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
  const backupKey = keyFromStdin ? await readKeyFromStdin() : null;
  const { getPath, restoreFromFile } = await import('../server/db.js');
  await fs.access(resolved);
  const result = await restoreFromFile(resolved, { backupKey });
  backupKey?.fill(0);
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
