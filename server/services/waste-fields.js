/**
 * Modul: Abfuhr - Wertelisten und Grenzen der Eingabefelder (#2810)
 * Zweck: EINE Quelle fuer zwei Leser, die nie auseinanderlaufen duerfen:
 *          - die Handpruefung in server/services/waste-domain.js,
 *            waste-store.js, waste-reminders.js, waste-url-source.js und den
 *            Routen unter server/routes/waste/, die mit diesen Listen und
 *            Grenzen weiter prueft;
 *          - das OpenAPI-Dokument (server/openapi/schemas.js,
 *            server/openapi/paths/waste.js), dessen Schemata validateRequest()
 *            vor dem Handler prueft.
 *        Diese Datei importiert nichts: server/openapi.js muss ohne
 *        node_modules ladbar bleiben (Paketvertrag), und die Dienste ziehen
 *        die Datenbank und den Netzwerkabruf nach.
 */

/** Die Wiederholungsarten eines Abfuhrplans (CHECK der Tabelle waste_schedules). */
export const RECURRENCE_KINDS = Object.freeze(['weekly', 'monthly_fixed_day', 'monthly_ordinal_weekday']);

/** Die Wochentagscodes (RRULE BYDAY), in dieser Reihenfolge gespeichert. */
export const WEEKDAY_CODES = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

/** Ordinale eines monthly_ordinal_weekday-Plans: -1 (letzter) oder 1-4 (n-ter). */
export const ORDINAL_WEEKDAY_VALUES = Object.freeze([-1, 1, 2, 3, 4]);

/** Laenge des Namens einer Abfuhrart (nach trim gezaehlt). */
export const TYPE_NAME_MAX = 100;

/** Laenge des Symbolnamens einer Abfuhrart (nach trim gezaehlt). */
export const TYPE_ICON_MAX = 60;

/** Laenge der Notiz einer Einmal-Abholung (nach trim gezaehlt). */
export const NOTE_MAX = 500;

/** Laenge des Namens einer Importquelle (nach trim gezaehlt). */
export const SOURCE_NAME_MAX = 150;

/** Vorlauf einer Abfuhr-Erinnerung in Tagen. */
export const MIN_OFFSET_DAYS = 0;
export const MAX_OFFSET_DAYS = 14;

/** Abrufabstand einer abonnierten Adresse in Minuten (stuendlich bis monatlich). */
export const MIN_REFRESH_INTERVAL_MINUTES = 60;
export const MAX_REFRESH_INTERVAL_MINUTES = 43_200;

/** Die Fassung des tragbaren Zuordnungsprofils, die der Export schreibt. */
export const MAPPING_PROFILE_VERSION = 1;

/**
 * Die Schreibweisen der Schalter `include_archived` und `include_inactive` in
 * der Query: die App schickt `include_archived=1`, der Handler liest `1` und
 * `true` als an, `0` und `false` als aus.
 */
export const QUERY_FLAG_VALUES = Object.freeze(['1', 'true', '0', 'false']);
