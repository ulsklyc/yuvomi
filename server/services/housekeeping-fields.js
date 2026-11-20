/**
 * Modul: Haushaltshilfe - Wertelisten, Grenzen und Muster der Eingabefelder (#2810)
 * Zweck: EINE Quelle fuer zwei Leser, die nie auseinanderlaufen duerfen:
 *          - die Handpruefung in server/routes/housekeeping.js, die mit diesen
 *            Listen und Grenzen weiter prueft;
 *          - das OpenAPI-Dokument (server/openapi/paths/housekeeping.js), dessen
 *            Schemata validateRequest() vor dem Handler prueft.
 *        Diese Datei importiert nichts: server/openapi.js muss ohne
 *        node_modules ladbar bleiben (Paketvertrag), und die Routen-Datei zieht
 *        express und die Datenbank nach.
 */

/** Wann die Kraft bezahlt wird; ohne Angabe `monthly` (CHECK der Tabelle housekeeping_workers). */
export const PAYMENT_SCHEDULES = ['daily', 'twice_monthly', 'monthly'];

/** Lohnart einer Kraft; ohne Angabe `daily`. */
export const RATE_TYPES = ['daily', 'hourly'];

/** Laenge des Anzeigenamens einer Kraft (nach trim gezaehlt). */
export const MAX_WORKER_NAME = 128;

/** Laenge des Benutzernamens einer Kraft (nach trim gezaehlt). */
export const MAX_WORKER_USERNAME = 64;

/**
 * Der Monat der Monatslisten (`?month=` an /summary, /work-sessions, /visits)
 * oder leer (= der laufende Monat). Der Monat ist 01 bis 12, das Jahr 1001 bis
 * 9999: householdMonthWindow() (services/housekeeping-month.js) wirft fuer
 * jedes Jahr bis 0999 in jeder Zone und fuer 1000 in einem Teil der Zonen
 * (gemessen ueber alle IANA-Zonen des Laufzeit-ICU), und vor #2810
 * endete das in einer 500. Ab 1001 rechnet sie in jeder Zone bis 9999-12.
 */
export const HOUSEKEEPING_MONTH_PATTERN = '^(?:(?:100[1-9]|10[1-9]\\d|1[1-9]\\d\\d|[2-9]\\d{3})-(?:0[1-9]|1[0-2]))?$';
