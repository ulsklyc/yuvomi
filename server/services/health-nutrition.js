/**
 * Modul: Gesundheit (Health) - Naehrwerte: die acht Spalten und die Tagesbilanz
 * Zweck: Die EINE Liste der acht Naehrwerte und die EINE Rechnung "was heute
 *        zusammengekommen ist, gegen das Ziel dieser Person". Beides liegt hier
 *        und nicht in der Route, weil zwei Aufrufer dieselbe Antwort brauchen:
 *        `GET /health/nutrition/summary` fuer den Tab und `/dashboard` fuer das
 *        Widget. Zwei Rechnungen waeren zwei Zahlen, die auseinanderlaufen.
 * Abhaengigkeiten: server/routes/health/helpers.js (die Sichtbarkeits-Klausel,
 *        die laut #884 nur dort gebaut werden darf)
 *
 * DIE ACHT SIND FEST (docs/DECISIONS.md Abschnitt 8). Sie stehen hier EINMAL
 * und werden von Migration, Route, Export und Oberflaeche aus dieser Liste
 * gelesen - acht Spalten, die an vier Stellen von Hand abgeschrieben werden,
 * sind genau die Bauform, in der eine davon an einer Stelle anders steht und es
 * niemandem auffaellt.
 */

import { careAwareClause, canWriteFor, OPEN_ALL } from '../routes/health/helpers.js';

/**
 * Die acht Naehrwerte in ihrer kanonischen Reihenfolge: Energie, Fett, davon
 * gesaettigte Fettsaeuren, Kohlenhydrate, davon Zucker, Eiweiss, Salz,
 * Ballaststoffe. Das ist die Reihenfolge der EU-Naehrwerttabelle auf der
 * Packung, und sie gilt fuer Formular, CSV-Kopfzeile und Anzeige gleichermassen
 * - wer sie hier aendert, aendert sie ueberall.
 */
export const NUTRIENT_KEYS = Object.freeze([
  'energy_kcal',
  'fat_g',
  'saturated_fat_g',
  'carbs_g',
  'sugar_g',
  'protein_g',
  'salt_g',
  'fiber_g',
]);

/** Die Mahlzeitenarten, die ein Eintrag optional tragen darf. */
export const MEAL_TYPES = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

/**
 * Das Tagesziel einer Person, oder `null`.
 *
 * NULL UND NULL SIND ZWEI VERSCHIEDENE DINGE, und diese Funktion ist die
 * Stelle, an der der Unterschied entsteht: keine Zeile heisst "diese Person hat
 * kein Ziel gesetzt" und kommt als `null` zurueck; eine Zeile, in der
 * `sugar_g = 0` steht, heisst "null Gramm Zucker, ausdruecklich" und kommt als
 * Objekt mit `sugar_g: 0` zurueck. Wer die Zeile mit `if (target.sugar_g)`
 * liest, macht aus der zweiten Aussage wieder die erste.
 *
 * @param {object} database
 * @param {number} userId
 * @returns {object|null} { energy_kcal, ... } mit je einer Zahl oder null
 */
export function nutritionTargetFor(database, userId) {
  const row = database.prepare(
    `SELECT ${NUTRIENT_KEYS.join(', ')} FROM health_nutrition_targets WHERE user_id = ?`
  ).get(userId);
  if (!row) return null;
  const target = {};
  for (const key of NUTRIENT_KEYS) target[key] = row[key] === null ? null : Number(row[key]);
  return target;
}

/**
 * Die Tagesbilanz einer Person: Ziel, Summen und Anzahl der Eintraege.
 *
 * `dayKey` IST EIN KALENDERTAG DES HAUSHALTS, kein UTC-Tag - der Aufrufer holt
 * ihn aus `todayKey(database)` (server/utils/timezone.js). `consumed_at` traegt
 * dieselbe Wanduhrzeit, deshalb reicht der Praefix-Vergleich auf die ersten
 * zehn Zeichen. Mit `toISOString().slice(0, 10)` stuende hier westlich von UTC
 * am Abend und oestlich davon am Morgen der Nachbartag.
 *
 * `viewer` entscheidet, welche Eintraege ueberhaupt mitzaehlen: der Eigentuemer
 * und eine betreuende Person sehen alle, jeder andere nur die, die der
 * Eigentuemer fuer den Haushalt geoeffnet hat. Die Klausel kommt aus
 * helpers.js, die einzige Stelle, an der sie gebaut werden darf (#884).
 *
 * @param {object} database
 * @param {number} viewer   - die lesende Person
 * @param {number} ownerId  - die Person, um deren Tag es geht
 * @param {string} dayKey   - YYYY-MM-DD in der Haushaltszone
 */
export function nutritionSummaryFor(database, viewer, ownerId, dayKey) {
  const clause = careAwareClause('e', viewer, ownerId, OPEN_ALL);
  const sums = NUTRIENT_KEYS.map((key) => `COALESCE(SUM(e.${key}), 0) AS ${key}`).join(', ');
  const row = database.prepare(`
    SELECT COUNT(*) AS entry_count, ${sums}
    FROM health_nutrition_entries e
    WHERE ${clause.sql} AND substr(e.consumed_at, 1, 10) = ?
  `).get(...clause.params, dayKey);

  const totals = {};
  for (const key of NUTRIENT_KEYS) totals[key] = Number(row?.[key] ?? 0);
  return {
    date: dayKey,
    // DAS ZIEL IST KEINE ZEILE MIT SICHTBARKEIT - es gibt nichts daran zu
    // oeffnen. Deshalb dieselbe Frage wie in `GET /nutrition/targets`: wer fuer
    // jemanden eintraegt, muss dessen Ziel kennen, jeder andere nicht. Ohne
    // diese Zeile haette die Bilanz das Ziel auch dann ausgeliefert, wenn die
    // Eintraege daneben allesamt weggefiltert waren.
    target: canWriteFor(viewer, ownerId) ? nutritionTargetFor(database, ownerId) : null,
    totals,
    entryCount: Number(row?.entry_count ?? 0),
  };
}
