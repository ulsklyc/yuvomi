/**
 * Modul: Anker einer bestaetigten Zutaten-Zuordnung (#1314, Stufe 1)
 * Zweck: Aus einem Zutatennamen den Schluessel machen, unter dem die
 *        Zuordnung zu einer Vorratszeile gespeichert ist.
 *
 * WARUM ES DIESEN SCHLUESSEL UEBERHAUPT GIBT. Nicht um Namen zu VERGLEICHEN -
 * das waere das Raten, das docs/DECISIONS.md Abschnitt 7 ausschliesst. Sondern
 * weil `recipe_ingredients` beim Speichern eines Rezepts komplett neu
 * geschrieben wird (DELETE + INSERT, server/routes/recipes.js und
 * server/services/recipe-provider-sync.js). Die Zeilen-ID einer Zutat ueberlebt
 * das nicht, ihr Name schon: er wird unveraendert wieder eingefuegt. Der
 * Schluessel ist also ein Wiedererkennungsmerkmal fuer DIESELBE Zutat in
 * DEMSELBEN Rezept, kein Urteil darueber, ob zwei Dinge dasselbe sind.
 *
 * DESHALB SO WENIG NORMALISIERUNG WIE MOEGLICH: Leerraum an den Raendern und in
 * der Mitte zusammengezogen, Gross-/Kleinschreibung egal. Genau das, was beim
 * Tippen desselben Namens schwankt. Kein Stemming, keine Synonyme, keine
 * Einheiten-Erkennung - jede weitere Regel waere eine Ableitung mehr, und die
 * Summe dieser Ableitungen ist der gepflegte Katalog, den #714 abgelehnt hat.
 *
 * `toLowerCase()` und nicht SQLites `lower()`: letzteres kennt nur ASCII und
 * macht aus "Öl" nicht "öl". Der Schluessel wird deshalb hier gebildet und
 * fertig gespeichert, nie in einer Abfrage berechnet.
 */

/**
 * @param {unknown} name Zutatenname, wie ihn der Haushalt geschrieben hat.
 * @returns {string} Der Schluessel, oder '' wenn nichts uebrig bleibt.
 */
export function ingredientMatchKey(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
