/**
 * Modul: Inventar - Wertelisten und Grenzen der Eingabefelder (#2810)
 * Zweck: EINE Quelle fuer zwei Leser, die nie auseinanderlaufen duerfen:
 *          - die Handpruefung der Routen (items.js, item-dates.js,
 *            entry-links.js), die mit diesen Listen und Grenzen weiter
 *            prueft;
 *          - das OpenAPI-Dokument (server/openapi/paths/inventory.js), dessen
 *            Schemata validateRequest() vor dem Handler prueft.
 *        Diese Datei importiert nichts: server/openapi.js muss ohne
 *        node_modules ladbar bleiben (Paketvertrag), und jede Route-Datei
 *        zieht express und die Datenbank nach.
 */

/** Zustand eines Gegenstands; ohne Angabe `good`. */
export const CONDITIONS = ['new', 'good', 'fair', 'poor'];

/** Status eines Gegenstands; ohne Angabe `active`. */
export const STATUSES = ['active', 'sold', 'disposed', 'lost'];

/** Einheit eines Kilometerstands. */
export const ODOMETER_UNITS = ['km', 'mi'];

/** Rolle einer verknuepften Buchung; ohne Angabe `purchase`. */
export const ROLES = ['purchase', 'refund', 'instalment', 'maintenance', 'accessory'];

/** ~5 MB Rohbild in base64, dieselbe Grenze wie birthdays.js und recipes.js. */
export const MAX_PHOTO_LENGTH = 6_990_507;

/** Hoechstens so viele frei definierte Fristen je Gegenstand. */
export const MAX_TRACKED_DATES_PER_ITEM = 10;

/** Laenge der Bezeichnung einer Frist und eines Wartungsbuch-Eintrags. */
export const MAX_LABEL = 100;
