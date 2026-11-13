/**
 * Module: care grants and health row rules (phase 2, section B4; until then
 *         server/authorize/rows/health.ts and server/routes/health/helpers.js)
 * Purpose: who may read and write whose health data: the owner, the open value of a
 *          table, or a care grant (health_care_grants, #584). The grant is given per
 *          person by an admin; the admin role itself replaces no grant (DECISIONS 1).
 *          Moved unchanged in B4: every fragment is the same SQL text with the same
 *          binds as before.
 *
 *          The viewer stays a value bound positionally, as before; the functions
 *          that read the grant table take the connection as their first parameter.
 *
 * Dependencies: catalog.ts for the Database type only; never server/db.js. Erasable
 * TS syntax only (runs through type stripping, no build).
 */

import type { Database } from './catalog.ts';

/** A WHERE fragment with its positional binds, in `params` order. */
type Clause = { sql: string; params: unknown[] };

/**
 * A row as SQLite hands it back. The columns are the caller's SELECT, unknown here;
 * the routes read them by name, as they did when the helper was untyped JavaScript.
 */
type Row = Record<string, any>;

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

/** The open value of the canonical set (nutrition, #1326). */
export const OPEN_ALL = 'all';

// Betreute Personen als Subquery statt als aufgelöste ID-Liste: die Zahl der
// Platzhalter bliebe sonst von den Daten abhängig, und jede aufrufende Route
// müsste die Liste selbst beschaffen.
const CARED_FOR_SUBQUERY = 'SELECT subject_id FROM health_care_grants WHERE caregiver_id = ?';

// --------------------------------------------------------
// The single questions on health_care_grants
// --------------------------------------------------------

/**
 * Does `caregiverId` hold a care grant for `subjectId`? Owning the data is no grant;
 * ask canWriteFor() for "may write".
 */
export function hasCareGrant(database: Database, caregiverId: unknown, subjectId: unknown): boolean {
  return !!database.prepare(
    'SELECT 1 FROM health_care_grants WHERE subject_id = ? AND caregiver_id = ?'
  ).get(subjectId, caregiverId);
}

/** IDs der Personen, für die `viewer` eintragen darf. Ohne Betreuung: []. */
export function caredForIds(database: Database, viewer: unknown): unknown[] {
  if (!viewer) return [];
  return database.prepare(CARED_FOR_SUBQUERY).all(viewer).map((r) => (r as { subject_id: unknown }).subject_id);
}

/** The caregivers of `subjectId`, in the table's order. Without a grant: []. */
export function caregiversOf(database: Database, subjectId: unknown): unknown[] {
  return database.prepare(
    'SELECT caregiver_id FROM health_care_grants WHERE subject_id = ?'
  ).all(subjectId).map((r) => (r as { caregiver_id: unknown }).caregiver_id);
}

/**
 * Darf `viewer` Daten schreiben, die `ownerId` gehören? Wahr für die eigenen
 * Daten und für jede Person, deren Betreuung eingeräumt wurde.
 */
export function canWriteFor(database: Database, viewer: unknown, ownerId: unknown): boolean {
  if (!viewer || !ownerId) return false;
  if (viewer === ownerId) return true;
  return hasCareGrant(database, viewer, ownerId);
}

// --------------------------------------------------------
// Row fragments
// --------------------------------------------------------

/**
 * Baut eine WHERE-Teilbedingung für Sichtbarkeit/Personen-Filter: Eigentümer
 * oder `visibility = 'family'`. Betreuung spielt hier bewusst KEINE Rolle -
 * dafür gibt es `careAwareClause()`.
 *
 * Warum zwei Funktionen statt eines Flags: so steht an jeder Aufrufstelle
 * lesbar, welches Modell gilt, und wer die Wahl vergisst, landet auf der
 * engeren Variante statt versehentlich fremde Daten zu öffnen.
 *
 * @param {string} alias         - Tabellen-Alias mit user_id + visibility
 * @param {number} viewer        - eingeloggter Nutzer
 * @param {number|null} personId  - optionaler Personen-Filter (?user_id=)
 * @param {string} open          - der offene Wert dieses Bereichs (siehe OPEN_FAMILY)
 * @returns {{ sql: string, params: any[] }}
 */
export function visibilityClause(alias: string, viewer: unknown, personId: unknown, open: string = OPEN_FAMILY): Clause {
  if (personId) {
    if (personId === viewer) return { sql: `${alias}.user_id = ?`, params: [viewer] };
    return { sql: `${alias}.user_id = ? AND ${alias}.visibility = ?`, params: [personId, open] };
  }
  return { sql: `(${alias}.user_id = ? OR ${alias}.visibility = ?)`, params: [viewer, open] };
}

/**
 * Wie `visibilityClause()`, zusätzlich mit den Daten betreuter Personen - auch
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
export function careAwareClause(alias: string, viewer: unknown, personId: unknown, open: string = OPEN_FAMILY): Clause {
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

/**
 * WHERE-Fragment für Zeilen, die `viewer` ändern oder löschen darf: die eigenen
 * plus die jeder betreuten Person. Ersetzt das frühere `user_id = ?`.
 * @param {string} alias - Tabellen-Alias oder '' für unqualifizierte Spalten
 */
export function writableClause(alias: string, viewer: unknown): Clause {
  const col = `${alias ? `${alias}.` : ''}user_id`;
  return {
    sql: `(${col} = ? OR ${col} IN (${CARED_FOR_SUBQUERY}))`,
    params: [viewer, viewer],
  };
}

/** The open values readableClause() may write into SQL text. */
const OPEN_VALUES: readonly string[] = [OPEN_FAMILY, OPEN_ALL];

/**
 * WHERE fragment for a single row the viewer may read: the open value, or a row the
 * viewer may write (own or cared for). Unlike careAwareClause() the open value is SQL
 * text here, not a bind - the lab report and medication lookups were written that
 * way, and the text stays. Only a known open value is accepted.
 * @param {string} alias - table alias, or '' for unqualified columns
 */
export function readableClause(alias: string, viewer: unknown, open: string = OPEN_FAMILY): Clause {
  if (!OPEN_VALUES.includes(open)) throw new TypeError(`readableClause: unknown open value '${String(open)}'`);
  const w = writableClause(alias, viewer);
  return { sql: `(${alias ? `${alias}.` : ''}visibility = '${open}' OR ${w.sql})`, params: w.params };
}

/**
 * Lädt einen abhängigen Datensatz, wenn `viewer` dessen Eltern-Zeile ändern
 * darf; sonst null.
 *
 * Zeitpläne und Dosis-Einträge hängen am Medikament, Analyte am Befund: sie
 * haben keine eigene `user_id`, ihr Scoping ist immer das des Elternteils. Wer
 * das von Hand als `m.user_id = ?` schreibt, schneidet die Betreuung (#584)
 * still wieder weg - genau das war #884: anlegen ging, wegräumen nicht. Die
 * Regel steht deshalb hier und nicht in jeder Route erneut.
 *
 * @param {string} sql         - SELECT … JOIN … WHERE <kind>.id = ?  (ohne Scope)
 * @param {string} parentAlias - Alias der Eltern-Tabelle mit `user_id`
 * @param {number} id          - ID des abhängigen Datensatzes
 * @param {number} viewer      - eingeloggter Nutzer
 */
export function writableChild(database: Database, sql: string, parentAlias: string, id: unknown, viewer: unknown): Row | null {
  const w = writableClause(parentAlias, viewer);
  return (database.prepare(`${sql} AND ${w.sql}`).get(id, ...w.params) as Row | undefined) ?? null;
}

/**
 * WHERE fragment over health_fasts (one bind: the subject): every row for the owner
 * and a caregiver, the family-visible ones for everyone else. Moved from
 * server/services/fasting.js; the grant is read only when the actor is not the owner.
 */
export function fastingVisibleFilter(database: Database, actorId: unknown, subjectId: unknown): string {
  const isOwner = actorId === subjectId;
  const grant = !isOwner && hasCareGrant(database, actorId, subjectId);
  return isOwner || grant ? 'user_id = ?' : "user_id = ? AND visibility = 'family'";
}
