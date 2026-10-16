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
 * Die Zuordnung ist die der Statistik seit R14 P8: groesste Ausgabe zuerst,
 * jenseits der Palette die Farbe der Sammelscheibe des Donuts. So teilen sich
 * im Donut nie zwei Segmente eine Farbe. Grundlage ist die Kategorienliste
 * des gezeigten Zeitraums (`byCategory` aus /budget/summary bzw. /stats).
 */

// Eigene Datenreihen-Palette (tokens.css) statt geborgter Fremdmodul-Akzente.
export const CATEGORY_SERIES_COLORS = Object.freeze([
  'var(--chart-series-1)', 'var(--chart-series-2)', 'var(--chart-series-3)',
  'var(--chart-series-4)', 'var(--chart-series-5)', 'var(--chart-series-6)',
  'var(--chart-series-7)',
]);

/**
 * Kategorie -> Index in CATEGORY_SERIES_COLORS, nach Ausgabenhoehe.
 * @param {Array<{category: string, expenses: number}>} byCategory
 * @returns {Map<string, number>}
 */
export function categoryColorIndex(byCategory) {
  const order = (byCategory ?? [])
    .filter((c) => c.expenses < 0)
    .sort((a, b) => Math.abs(b.expenses) - Math.abs(a.expenses));
  return new Map(order.map((c, i) => [c.category, Math.min(i, CATEGORY_SERIES_COLORS.length - 1)]));
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
  return i == null ? null : CATEGORY_SERIES_COLORS[i];
}
