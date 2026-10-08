/**
 * Modul: Der eine Zugang zum Datenbanktreiber
 * Zweck: Jeder Code, der eine Datenbank oeffnet, holt `Database` von hier und
 *        nicht direkt aus dem Paket. So laeuft die Laufzeitpruefung genau
 *        einmal und sicher VOR dem ersten `new Database()` - auch fuer Skripte,
 *        die ohne server/index.js oder server/db.js auskommen.
 * Abhaengigkeiten: better-sqlite3-multiple-ciphers, ./node-runtime.js
 *
 * Reihenfolge: ES-Module werten ihre Imports aus, bevor der eigene Rumpf
 * laeuft, und den Rumpf des Importierten vor dem des Importierenden. Die
 * Pruefung hier unten laeuft also, bevor irgendeine Datei, die dieses Modul
 * importiert, ihre erste Zeile ausfuehrt. Das Laden des Treibers davor ist
 * harmlos (gemessen: erst der Konstruktor stuerzt ab).
 *
 * `test:node-runtime` haelt fest, dass ausserhalb von test/ nur diese Datei den
 * Treiber importiert.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { assertSupportedRuntime } from './node-runtime.js';

assertSupportedRuntime();

export default Database;
