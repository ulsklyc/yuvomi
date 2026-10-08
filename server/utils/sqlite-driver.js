/**
 * Modul: Der eine Zugang zum Datenbanktreiber
 * Zweck: Jeder Code, der eine Datenbank oeffnet, holt `Database` von hier und
 *        nicht direkt aus dem Paket. So laeuft die Laufzeitpruefung genau
 *        einmal und sicher VOR dem ersten `new Database()` - auch fuer Skripte,
 *        die ohne server/index.js oder server/db.js auskommen.
 * Abhaengigkeiten: ./require-supported-runtime.js, better-sqlite3-multiple-ciphers
 *
 * DIE REIHENFOLGE DER BEIDEN IMPORTE IST DIE SACHE. ES-Module werten Importe in
 * Quellreihenfolge aus: die Pruefung steht ueber dem Treiber und ist gelaufen,
 * bevor er geladen wird. Dass der Treiber sein Binary heute erst im Konstruktor
 * laedt, ist eine Eigenschaft seiner Version und keine Zusage.
 *
 * `test:node-runtime` haelt die Reihenfolge fest (als Text und an einem
 * Treiber, dessen Laden scheitert) und dass ausserhalb von test/ nur diese
 * Datei den Treiber importiert.
 */

import './require-supported-runtime.js';
import Database from 'better-sqlite3-multiple-ciphers';

export default Database;
