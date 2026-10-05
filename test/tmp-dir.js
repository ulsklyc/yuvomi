/**
 * Modul: Temp-Verzeichnisse in Tests
 * Zweck: Ein `mkdtemp` unter dem Temp-Ordner, das beim Prozessende wieder
 *        verschwindet - auch wenn die Suite unterwegs wirft.
 * Abhaengigkeiten: node:fs, node:os, node:path
 *
 * Gemessen am 2026-09-22: die Platte lief voll (ENOSPC), weil Suiten ihre
 * `mkdtempSync(join(tmpdir(), ...))`-Verzeichnisse nie wegraeumten. Ein Lauf
 * von test:restore-rekey liess 35 Verzeichnisse liegen, test:db-encryption 70;
 * im Temp-Ordner lagen 570 `yuvomi-test-rekey-*` mit 1,8 GB. Einzeln sind die
 * Reste klein, aber jede Suite laeuft in jedem Push viele Male.
 *
 * Aufgeraeumt wird im `exit`-Ereignis und nicht in `after()`: es feuert auch
 * nach einem Fehlschlag, braucht keinen node:test-Kontext und kommt nach jedem
 * `after()`, das Server schliesst. Datenbanken, die ein Test bewusst offen
 * laesst (etwa um einen `docker stop` ohne close() nachzustellen), sind dann
 * noch offen - unter POSIX loescht `rm` die Datei trotzdem, und geschrieben
 * wird im `exit` nichts mehr.
 *
 * `test:tmp-clean` faehrt die Suiten mit eigenem TMPDIR und verlangt, dass
 * nichts liegen bleibt.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = [];

process.on('exit', () => {
  for (const dir of created) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort am Prozessende */ }
  }
});

/**
 * Legt ein frisches Verzeichnis `<tmpdir>/<prefix>XXXXXX` an und raeumt es beim
 * Prozessende samt Inhalt weg.
 *
 * @param {string} prefix z.B. 'yuvomi-accmig-'
 * @returns {string} absoluter Pfad
 */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
