/**
 * Modul: Handschlag fuer die Instanzsperre des Servers (#1530)
 * Zweck: Steht als ERSTER Import in server/index.js. ES-Module werden in der
 *        Reihenfolge ihrer Imports ausgewertet, dieser also vor server/db.js -
 *        dessen `init()` nimmt die Sperre dann, bevor es irgendeine Datei neben
 *        DB_PATH anfasst. `'wait'`: haelt ein CLI-Restore sie, wartet der Server.
 *        Siehe server/utils/instance-lock.js.
 */
globalThis[Symbol.for('yuvomi.db.instanceLock')] = 'wait';
