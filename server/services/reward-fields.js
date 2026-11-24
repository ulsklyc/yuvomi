/**
 * Modul: Belohnungen - Wertelisten und Grenzen der Eingabefelder (#2810)
 * Zweck: EINE Quelle fuer zwei Leser, die nie auseinanderlaufen duerfen:
 *          - die Handpruefung in server/routes/rewards.js und
 *            server/services/reward-money.js, die mit diesen Listen und
 *            Grenzen weiter prueft;
 *          - das OpenAPI-Dokument (server/openapi/paths/rewards.js), dessen
 *            Schemata validateRequest() vor dem Handler prueft.
 *        Diese Datei importiert nichts: server/openapi.js muss ohne
 *        node_modules ladbar bleiben (Paketvertrag), und die Routen- und
 *        Dienst-Dateien ziehen express und die Datenbank nach.
 */

/** Hoechster Preis einer Praemie in Punkten. */
export const MAX_COST = 1_000_000;
/** Hoechster Betrag einer Bonus- oder Korrekturbuchung in Punkten (beide Richtungen). */
export const MAX_BONUS = 1_000_000;
/** Hoechste Stueckzahl einer Praemie. */
export const MAX_QUANTITY = 1_000_000;

/** Die beiden Arten einer Geld-Anfrage (#1734). */
export const MONEY_KINDS = Object.freeze(['withdrawal', 'deposit']);
/** Rhythmus eines Taschengeld-Plans. */
export const ALLOWANCE_FREQUENCIES = Object.freeze(['weekly', 'monthly']);
/** Richtung einer direkten Geldbuchung der Eltern. */
export const MONEY_DIRECTIONS = Object.freeze(['credit', 'debit']);

/** Status einer Einloese-Anfrage (Filter `?status=` an GET /redemptions). */
export const REDEMPTION_STATUSES = Object.freeze(['pending', 'fulfilled', 'rejected', 'cancelled']);

/** Die Entscheidungen an einer offenen Anfrage. */
export const REDEMPTION_DECISIONS = Object.freeze(['fulfill', 'reject', 'cancel']);
/** Alles, was PATCH /redemptions/{id} als `action` annimmt: die Entscheidungen und ihr Rueckweg. */
export const REDEMPTION_ACTIONS = Object.freeze([...REDEMPTION_DECISIONS, 'reopen']);

/**
 * `?kind=` an GET /redemptions: je Wert das SQL-Fragment, das die Liste
 * siebt. Der Wert ist eine Konstante, nie Eingabe; die Route schlaegt nur
 * eigene Schluessel nach (`Object.hasOwn`), das Dokument nimmt die Schluessel
 * als Werteliste.
 */
export const REDEMPTION_KIND_FILTERS = Object.freeze({
  reward: "r.kind = 'reward'",
  money: "r.kind != 'reward'",
  all: '1 = 1',
  withdrawal: "r.kind = 'withdrawal'",
  deposit: "r.kind = 'deposit'",
});
