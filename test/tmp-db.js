/**
 * Modul: Datei-Datenbanken in Tests
 * Zweck: Die eine Regel, wie eine Suite zu ihrer Datei-Datenbank kommt - und
 *        warum sie sie ZUERST wegraeumt und nicht nur zuletzt.
 * Abhaengigkeiten: node:fs, node:os, node:path
 *
 * WAS DAS HIER SOLL, IST EIN GEMESSENER FEHLER UND KEINE VORSICHTSMASSNAHME.
 *
 * Neun Suiten legen ihre Datenbank als `<name>-${process.pid}.db` in den
 * Temp-Ordner. Aufgeraeumt wurde am ENDE - was genau dann nicht passiert, wenn
 * es darauf ankommt: bricht ein Lauf ab, bleibt die Datei liegen. Betriebs-
 * systeme vergeben PIDs wieder, und irgendwann trifft ein neuer Lauf auf die
 * volle Datenbank eines alten. Er migriert sie, findet Bestandsdaten vor und
 * scheitert an einem UNIQUE-Constraint, den sein eigener Code nie verletzt
 * haette.
 *
 * Gemessen am 2026-08-29: 182 verwaiste `yuvomi-contact-names-*.db` im
 * Temp-Ordner, aelteste vier Tage alt, zusammen rund 250 MB - und ein roter
 * Lauf, der isoliert nicht zu reproduzieren war. Das ist die teuerste Sorte
 * Fehlschlag: er zeigt auf die Aenderung, die gerade entsteht, und meint sie
 * nicht.
 *
 * Der Ausweg ist eine Zeile Reihenfolge: VOR dem Oeffnen wegraeumen. Dann
 * startet jeder Lauf frisch, egal was ein abgebrochener hinterlassen hat. Das
 * Aufraeumen am Ende bleibt - es haelt den Ordner sauber, aber es ist nicht
 * mehr das, worauf die Korrektheit steht.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Die Dateien, die SQLite anlegt - WAL und Journal gehoeren dazu -, dazu die
 * Instanzsperre, die jeder Server neben seiner Datenbank haelt (#1530).
 */
const SUFFIXES = ['', '-wal', '-shm', '-journal', '.lock'];

function removeAll(dbPath) {
  for (const suffix of SUFFIXES) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* war nicht da, gut so */ }
  }
}

/**
 * Liefert den Pfad einer frischen Datei-Datenbank fuer diese Suite.
 *
 * Zu rufen, BEVOR `server/db.js` importiert wird - der Import liest `DB_PATH`
 * beim Laden. Setzt `process.env.DB_PATH` gleich mit, damit der Aufrufer es
 * nicht ein zweites Mal von Hand tun muss und die beiden nicht auseinander
 * laufen koennen.
 *
 * @param {string} name Sprechender Teil des Dateinamens, z.B. 'contact-names'
 * @returns {string} absoluter Pfad
 */
export function freshTestDbPath(name) {
  const dbPath = path.join(os.tmpdir(), `yuvomi-${name}-${process.pid}.db`);
  removeAll(dbPath);
  process.env.DB_PATH = dbPath;

  // Auch am Ende, und auch wenn die Suite unterwegs wirft: `exit` feuert in
  // beiden Faellen. Ein liegengebliebener Rest ist zwar nicht mehr gefaehrlich
  // (der naechste Lauf raeumt ihn oben weg), aber 1,4 MB je Suite je Lauf
  // summieren sich, und das hat hier vier Tage lang niemand bemerkt.
  process.on('exit', () => removeAll(dbPath));
  return dbPath;
}
