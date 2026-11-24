// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 279,
    description: 'tasks: external_rrule keeps the recurrence rule another app owns',
    // #2506/#2515: eine in iOS Erinnerungen oder Tasks.org angelegte Serie kam
    // als Einmal-Aufgabe an. Hakte Yuvomi sie ab, ging STATUS:COMPLETED auf den
    // Master mit der RRULE, und die besitzende App beendete die ganze Serie.
    // Die Spalte haelt die fremde Regel woertlich fest (der Inbound schreibt
    // sie bei jedem Abruf, NULL ohne Regel oder bei Yuvomis eigener). Solange
    // sie steht, sperren die Routen das Abhaken und der Push schickt nie
    // COMPLETED auf diesen Master. Reines SQL, damit der Testspiegel
    // (db-schema-test.js) sie fuehren kann; eine gedriftete Datenbank ohne die
    // Spalte heilt reconcileCriticalSchema.
    up: `ALTER TABLE tasks ADD COLUMN external_rrule TEXT;`,
  };
