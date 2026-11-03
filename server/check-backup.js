/**
 * Modul: Backup pruefen, ohne es einzuspielen (#1431)
 * Zweck: Pruefschritt des dokumentierten Compose-Restores (docs/installation.md,
 *        „Restore"). Der Befehl ersetzt die Datenbankdatei von Hand; vorher
 *        laeuft hier dieselbe Validierung wie vor jedem Restore aus der App:
 *        mit DB_ENCRYPTION_KEY dieser Instanz lesbar, jede Seite heil,
 *        Yuvomi-Schema, keine neuere Version.
 *
 * Liegt unter server/ und nicht unter scripts/, weil scripts/ nicht im Image
 * ist (.dockerignore). Oeffnet die laufende Datenbank nicht (Handschlag vor dem
 * Import): sie kann leer sein oder einen anderen Schluessel tragen - genau die
 * Faelle, fuer die es den manuellen Weg gibt. Den Schluessel liest es wie der
 * Server, auch aus `.secrets/` (server/utils/auto-secrets.js), legt aber nie
 * einen an.
 *
 * Aufruf: node server/check-backup.js <backup-datei>
 * Exit 0: Backup in Ordnung. Exit 1: Meldung auf stderr, nichts geaendert.
 */

import { applyFileSecrets } from './utils/file-secrets.js';
import { applyAutoSecrets } from './utils/auto-secrets.js';

globalThis[Symbol.for('yuvomi.db.checkOnly')] = true;

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('Usage: node server/check-backup.js <backup-file>');
  process.exit(1);
}

// Den Schluessel finden wie der Server: DB_ENCRYPTION_KEY, dann _FILE, dann
// die beim ersten Start gespeicherte Datei. Aber NUR LESEN (`create: false`),
// nicht server/utils/load-file-secrets.js: dessen Handschlag erzeugte auf
// einem leeren Volume einen Schluessel und legte .secrets an - ein Pruefschritt,
// der den Zustand aendert, den er pruefen soll.
const quiet = { info() {}, warn: (msg) => console.error(msg) };
let exitCode = 1;
try {
  applyAutoSecrets({ fromFile: applyFileSecrets(), log: quiet, create: false });
  const { checkBackupFile } = await import('./db.js');
  const version = checkBackupFile(backupPath);
  console.log(`Backup check passed: ${backupPath} (schema v${version}).`);
  exitCode = 0;
} catch (err) {
  console.error(`Backup check failed: ${err?.message || err}`);
}
process.exit(exitCode);
