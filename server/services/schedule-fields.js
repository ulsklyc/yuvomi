/**
 * Modul: Schichtplan - Grenzen der Eingabefelder (#2810)
 * Zweck: EINE Quelle fuer zwei Leser, die nie auseinanderlaufen duerfen:
 *          - die Handpruefung in server/routes/schedule.js,
 *            schedule-extras.js und schedule-preferences.js;
 *          - das OpenAPI-Dokument (server/openapi/paths/schedule.js), dessen
 *            Schemata validateRequest() vor dem Handler prueft.
 *        Diese Datei importiert nichts: server/openapi.js muss ohne
 *        node_modules ladbar bleiben (Paketvertrag), und die Routen-Dateien
 *        ziehen express und die Datenbank nach.
 */

/** Laenge des Kurzzeichens einer Schichtart (nach trim gezaehlt). */
export const MAX_SHORT_CODE = 12;

/** Laenge des Symbolnamens einer Schichtart (nach trim gezaehlt). */
export const MAX_ICON_NAME_LENGTH = 48;

/** Laenge des Namens eines eigenen Felds (nach trim gezaehlt). */
export const MAX_CUSTOM_FIELD_NAME = 100;

/** Laenge eines Feldwerts (nach trim gezaehlt). */
export const MAX_FIELD_VALUE_LENGTH = 500;

/** Laenge einer Notiz an Abweichung oder Zusatzschicht. */
export const MAX_SCHEDULE_NOTE = 5000;

/** Laenge eines Zyklus in Tagen. */
export const MIN_CYCLE_LENGTH = 1;
export const MAX_CYCLE_LENGTH = 366;

/** Zeilen eines Zyklus (PUT /patterns/{id}/days). */
export const MAX_PATTERN_DAY_ROWS = 500;

/** Vorlauf einer Schicht-Erinnerung in Minuten (eigene Einstellung und Zusatzschicht). */
export const MAX_REMINDER_OFFSET_MINUTES = 24 * 60;

/** Wochenstunden-Ziel. */
export const MIN_WEEKLY_HOURS = 1;
export const MAX_WEEKLY_HOURS = 168;
