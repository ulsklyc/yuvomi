/**
 * Modul: Geteilte Ausgaben - Wertelisten und Grenzen der Eingabefelder (#2810)
 * Zweck: EINE Quelle fuer zwei Leser, die nie auseinanderlaufen duerfen:
 *          - die Handpruefung in server/routes/split-expenses.js, die mit diesen
 *            Listen weiter prueft (und `GET /meta` sie ausliefert);
 *          - das OpenAPI-Dokument (server/openapi/paths/splitexpenses.js), dessen
 *            Schemata validateRequest() vor dem Handler prueft.
 *        Die Waehrungen stehen in public/utils/currency-codes.js (eine Liste
 *        fuer Server und Browser, #841). Diese Datei importiert nichts:
 *        server/openapi.js muss ohne node_modules ladbar bleiben
 *        (Paketvertrag), und die Routen-Datei zieht express und die Datenbank
 *        nach.
 */

/** Art einer Gruppe; ohne Angabe `general`. */
export const GROUP_TYPES = ['household', 'couple', 'travel', 'event', 'shopping', 'general'];

/** Rolle in einer Gruppe. `owner` vergibt nur das Anlegen. */
export const GROUP_ROLES = ['owner', 'admin', 'guest'];

/** Aufteilungsarten einer Ausgabe; ohne Angabe `equal`. */
export const SPLIT_METHODS = ['equal', 'exact', 'percentage', 'shares'];

/** Die alte Kategorie einer Ausgabe (Feld `category` der /api/v1-Oberflaeche). */
export const CATEGORIES = ['groceries', 'rent', 'utilities', 'baby', 'pets', 'school', 'travel', 'shopping', 'subscriptions', 'health', 'home', 'general'];

/** Rhythmus einer Serie. */
export const FREQUENCIES = ['weekly', 'monthly', 'yearly'];

/** Familienrolle eines neuen Gastes; ohne Angabe `other`. */
export const FAMILY_ROLES = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];

/**
 * Was mit versaeumten Terminen einer Serie geschieht (#1748): `skip` ab dem
 * ersten Termin, der nicht vor heute liegt; `book` bucht sie nach.
 */
export const MISSED_MODES = ['skip', 'book'];

/** Laenge des Anzeigenamens eines neuen Gastes (nach trim gezaehlt). */
export const MAX_GUEST_NAME = 128;

/** Laenge der Telefonnummer eines neuen Gastes (nach trim gezaehlt). */
export const MAX_GUEST_PHONE = 100;

/** Laenge der E-Mail-Adresse eines neuen Gastes (nach trim gezaehlt). */
export const MAX_GUEST_EMAIL = 200;

/** Laenge eines Cursorteils (`before_date`, `before_at`) der Listen. */
export const MAX_CURSOR_TEXT = 64;

/** Die Gruppenliste: `archived` oder alles andere aktiv. */
export const GROUP_STATUSES = ['active', 'archived'];
