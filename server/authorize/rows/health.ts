/**
 * Module: row visibility of health data (phase 2, section B3; until then
 *         server/services/visibility.js)
 * Purpose: owner, the open value of a table, or a care grant. Moved unchanged in B3;
 *          B4 builds the care rule out of it.
 *
 * Dependencies: none. Erasable TS syntax only (runs through type stripping, no build).
 */

/** The answer of careAwareClause(): the fragment and its positional binds. */
type CareClause = { sql: string; params: unknown[] };

// --------------------------------------------------------
// Health rows: owner, `family`, or a care grant (#584).
//
// The clause was born in routes/health/helpers.js and is re-exported there for
// every health route. It lives here because the global search asks it too, and
// a service must not import a route module. It moved unchanged: the lists get
// the same SQL as before.
// --------------------------------------------------------

/**
 * Der OFFENE Wert eines Bereichs - das Gegenstueck zu 'private'.
 *
 * Die Gesundheit schreibt seit jeher 'family'. Ein Bereich, der nach
 * docs/DECISIONS.md Abschnitt 5 neu dazukommt, nimmt den kanonischen Satz von
 * Anfang an und schreibt dort 'all'; Abschnitt 5 nennt das Lesen als die
 * Stelle, an der beide Schreibweisen zusammenkommen ("der Lesepfad bildet
 * `family` und `shared` auf `all` ab"), und genau das ist dieser Parameter.
 *
 * Er steht als Vorgabewert auf 'family', damit jede bestehende Aufrufstelle
 * unveraendert dasselbe SQL bekommt wie vorher - ein neuer Bereich muss den
 * Wert nennen, ein alter merkt nichts.
 */
export const OPEN_FAMILY = 'family';

// Betreute Personen als Subquery statt als aufgelöste ID-Liste: die Zahl der
// Platzhalter bliebe sonst von den Daten abhängig, und jede aufrufende Route
// müsste die Liste selbst beschaffen.
export const CARED_FOR_SUBQUERY = 'SELECT subject_id FROM health_care_grants WHERE caregiver_id = ?';

/**
 * Wie `visibilityClause()` (routes/health/helpers.js), zusätzlich mit den Daten betreuter Personen - auch
 * deren privaten (#584). Gilt für Vitalwerte, Medikamente, Laborbefunde,
 * Aktivitäten, Vorsorge und die Naehrwerte (#1326).
 *
 * `open` ist der Wert, den DIESE Tabelle fuer "der Haushalt darf mitlesen"
 * schreibt. Er wandert als Bind-Parameter ins SQL statt als eingebautes
 * 'family', weil die Naehrwert-Tabelle den kanonischen Satz fuehrt und dort
 * 'all' steht - ein fest verdrahtetes 'family' haette dort NIE getroffen, und
 * zwar lautlos: die Abfrage bliebe gueltig und lieferte einfach nichts.
 *
 * No admin branch: the admin role replaces no care grant (DECISIONS 1).
 *
 * @param {string} alias          table alias with user_id + visibility
 * @param {number} viewer         the signed-in person
 * @param {number|null} personId  optional person filter (?user_id=)
 * @param {string} [open]         the open value of this table
 * @returns {{ sql: string, params: any[] }} positional binds, in `params` order
 */
export function careAwareClause(alias: string, viewer: unknown, personId: unknown, open: string = OPEN_FAMILY): CareClause {
  if (personId) {
    if (personId === viewer) return { sql: `${alias}.user_id = ?`, params: [viewer] };
    // Betreute Person: volle Sicht wie der Eigentümer. Für alle anderen bleibt
    // es beim Familien-Filter.
    return {
      sql: `${alias}.user_id = ? AND (${alias}.visibility = ? OR ? IN (${CARED_FOR_SUBQUERY}))`,
      params: [personId, open, personId, viewer],
    };
  }
  return {
    sql: `(${alias}.user_id = ? OR ${alias}.visibility = ? OR ${alias}.user_id IN (${CARED_FOR_SUBQUERY}))`,
    params: [viewer, open, viewer],
  };
}
