/**
 * Module: row visibility of notes and note categories (phase 2, section B3; until then
 *         noteVisibleWhere() in server/services/visibility.js and the two category
 *         predicates in server/services/note-categories.js)
 * Purpose: which notes and which note categories a viewer sees. The category service
 *          (server/services/note-categories.js) stays where it is and imports the
 *          predicates from server/authorize/index.ts.
 *
 * Dependencies: none. Erasable TS syntax only (runs through type stripping, no build).
 */

/** The category fields categoryVisibleTo() reads. */
type CategoryRow = { scope?: string | null; owner_user_id?: unknown };

/**
 * WHERE-Fragment fuer die Sichtbarkeit einer NOTIZ (#1514): `all` oder die
 * eigene. Dieselbe Regel wie `visibilityWhere()`, ohne den Zuweisungs-Zweig -
 * Notizen haben keine Zugewiesenen. Kein Admin-Zweig (DECISIONS 1).
 *
 * EINE STELLE FUER JEDEN LESEWEG: Liste, Aenderungswege per Kennung, Suche und
 * die Notizkachel der Uebersicht haengen dieses Fragment an.
 *
 * @param {string} alias  Tabellen-Alias der Notizen (z. B. 'n')
 * @param {string} bind   Platzhalter der betrachtenden User-ID: '?' (EIN
 *                        positionaler Bind) oder benannt wie '@me'
 * @returns {string} SQL-Fragment (ohne fuehrendes AND)
 */
export function noteVisibleWhere(alias: string, bind: string = '?'): string {
  return `(${alias}.visibility = 'all' OR ${alias}.created_by = ${bind})`;
}

/**
 * WHERE-Fragment fuer "die Kategorie ist fuer userId sichtbar": jede
 * Haushaltskategorie, dazu die eigenen persoenlichen. `alias` ist der
 * Tabellen-Alias ('' fuer keinen), `bind` der Platzhalter fuer owner_user_id -
 * `?` fuer positionale Bindung, `@name` fuer eine benannte (wie bei
 * `noteVisibleWhere()` oben).
 *
 * EINE STELLE, weil die Regel an vier Stellen in services/note-categories.js und einmal in
 * dashboard.js wortgleich stand (#2601) - und dort schon einmal ohne das
 * `scope = 'personal' AND` drifted war: `nc.scope = 'household' OR
 * nc.owner_user_id = @me` traf zufaellig dieselbe Menge, weil heute keine
 * dritte scope existiert, haette eine vierte scope das aber lautlos falsch
 * gemacht.
 */
export function categoryVisibleWhere(alias: string, bind: string = '?'): string {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  return `(${col('scope')} = 'household' OR (${col('scope')} = 'personal' AND ${col('owner_user_id')} = ${bind}))`;
}

/** Wie `categoryVisibleWhere()`, als JS-Praedikat auf eine schon geladene Zeile. */
export function categoryVisibleTo(category: CategoryRow, userId: unknown): boolean {
  return category.scope === 'household'
    || (category.scope === 'personal' && Number(category.owner_user_id) === Number(userId));
}
