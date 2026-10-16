/**
 * Module: Budget-Kategoriefarben
 * Purpose: EINE Farbe je Ausgabenkategorie in jeder Budget-Ansicht.
 *
 * DIE KATEGORIE BEHAELT IHRE FARBE (Critique 2026-10-16, D9). „Wohnen" stand
 * in der Uebersicht im Modulton, im Plan in Amber (dem Zustand „knapp") und in
 * der Statistik in ihrer Serienfarbe - dieselbe Kategorie in drei Farben. Die
 * Farbe ist jetzt die Identitaet der Kategorie und kommt fuer Uebersicht, Plan
 * und Statistik aus dieser einen Zuordnung. Ein Zustand (knapp, ueber Plan)
 * spricht ueber Text und Icon, nicht durch Umfaerben.
 *
 * DIE FARBE FOLGT DER KATEGORIE, NICHT DEM RANG (R19, Critique 2026-10-16).
 * Bis dahin vergab die Zuordnung die Serienfarben nach Ausgabenhoehe im
 * gezeigten Zeitraum - "Wohnen" war im Oktober Serie 1 und im November, als
 * der Urlaub teurer war, Serie 2. Jetzt hat jede Kategorie eine BEVORZUGTE
 * Farbe aus ihrer Stelle im Katalog des Haushalts (Reihenfolge der
 * Kategorienliste, also stabil ueber Monate und Ansichten). Nur wenn zwei im
 * selben Zeitraum gezeigte Kategorien dieselbe bevorzugte Farbe haetten (mehr
 * Kategorien als Farben), weicht die kleinere auf die naechste freie aus - so
 * teilen sich im Donut weiterhin nie zwei Segmente eine Farbe. Sind alle
 * Farben vergeben, traegt der Rest die neutrale Farbe der Sammelscheibe.
 */

// Eigene Datenreihen-Palette (tokens.css) statt geborgter Fremdmodul-Akzente.
export const CATEGORY_SERIES_COLORS = Object.freeze([
  'var(--chart-series-1)', 'var(--chart-series-2)', 'var(--chart-series-3)',
  'var(--chart-series-4)', 'var(--chart-series-5)', 'var(--chart-series-6)',
  'var(--chart-series-7)',
]);

/** Farbe der Sammelscheibe ("Sonstige") und jeder Kategorie jenseits der Palette. */
export const CATEGORY_OTHER_COLOR = 'var(--color-text-tertiary)';

/**
 * Kategorie -> Index in CATEGORY_SERIES_COLORS (-1 = Sammelfarbe).
 * @param {Array<{category: string, expenses: number}>} byCategory  der gezeigte Zeitraum
 * @param {string[]} [catalog]  Schluessel der Ausgabenkategorien in Katalog-Reihenfolge
 * @returns {Map<string, number>}
 */
export function categoryColorIndex(byCategory, catalog = []) {
  const size = CATEGORY_SERIES_COLORS.length;
  const position = new Map((catalog ?? []).map((key, i) => [key, i]));
  const shown = (byCategory ?? [])
    .filter((c) => c.expenses < 0)
    .sort((a, b) => Math.abs(b.expenses) - Math.abs(a.expenses));
  // Was der Katalog nicht kennt (die Maske fremder Buchungen, eine geloeschte
  // Kategorie), reiht sich hinter dem Katalog ein - in der Reihenfolge ihres
  // Schluessels, also ebenfalls stabil.
  const strangers = [...new Set(shown.map((c) => c.category).filter((key) => !position.has(key)))].sort();
  strangers.forEach((key, i) => position.set(key, (catalog?.length ?? 0) + i));
  const taken = new Set();
  const out = new Map();
  for (const c of shown) {
    const preferred = position.get(c.category) % size;
    let index = -1;
    for (let step = 0; step < size; step += 1) {
      const candidate = (preferred + step) % size;
      if (!taken.has(candidate)) { index = candidate; break; }
    }
    if (index >= 0) taken.add(index);
    out.set(c.category, index);
  }
  return out;
}

/**
 * Die Farbe einer Kategorie als CSS-Wert, oder `null` ohne Ausgaben im
 * Zeitraum (dann hat sie keinen Balken, der eine Farbe braucht).
 * @param {Map<string, number>} index - aus categoryColorIndex()
 * @param {string} category
 * @returns {string|null}
 */
export function categoryColor(index, category) {
  const i = index?.get(category);
  if (i == null) return null;
  return i < 0 ? CATEGORY_OTHER_COLOR : CATEGORY_SERIES_COLORS[i];
}
