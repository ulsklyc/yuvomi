/**
 * Modul: Laufzeitpruefung als Seiteneffekt
 * Zweck: Wer dieses Modul importiert, hat die Pruefung hinter sich, sobald der
 *        Import ausgewertet ist. server/utils/sqlite-driver.js importiert es in
 *        der Zeile UEBER dem Treiber: ES-Module werten Importe in
 *        Quellreihenfolge aus, die Pruefung laeuft also, bevor der Treiber
 *        ueberhaupt geladen wird.
 * Abhaengigkeiten: ./node-runtime.js - und nichts sonst. Jeder weitere Import
 *        hier liefe vor der Pruefung.
 */

import { assertSupportedRuntime } from './node-runtime.js';

assertSupportedRuntime();
