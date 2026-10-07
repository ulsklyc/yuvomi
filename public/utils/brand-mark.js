/**
 * Modul: Die Bildmarke (brand-mark)
 * Zweck: EINE Quelle fuer das Yuvomi-Zeichen in der App - die Kachel mit
 *        Verlauf und den drei hellen, transluzenten Kreisen.
 * Abhaengigkeiten: keine
 *
 * WARUM (R18): die Marke stand zweimal im Code und sah zweimal anders aus.
 * - Die Seitenleiste baute sie per DOM-API in router.js: Verlaufskachel,
 *   weisse Kreise, aber der Verlauf hing an `--color-accent`, das im Dark
 *   aufhellt - dort also Weiss auf Flieder.
 * - Die Zugangsseiten (auth-ui.js) malten nur die Kreise, in `currentColor`,
 *   auf eine akzentfarbene Kachel: im Dark dunkle Punkte auf Flieder, und die
 *   Kreise fuellten rund 30 % der Kachel statt die Haelfte.
 *
 * Eine Marke kippt nicht mit dem Theme. Form und Farben sind die von
 * `docs/logo.svg` und den App-Icons (`public/icons/`): Verlauf #8B5CF6 nach
 * #6C3AED von oben links nach unten rechts, Radius 36 auf 160, drei Kreise in
 * Weiss mit 0,82 Deckung. Die beiden Verlaufsfarben stehen als Tokens in
 * tokens.css (`--brand-mark-from`/`--brand-mark-to`) und werden ueber Klassen
 * gesetzt (layout.css), nicht ueber Attribute - so traegt das Markup keine
 * Farbe.
 *
 * Ohne den Glanz (`sheen`) des App-Icons: bei 28px in der Seitenleiste ist er
 * nicht zu sehen, und zwei Fassungen waeren wieder zwei Marken.
 */

let seq = 0;

/** Die drei Kreise der Marke im 160er-Raster: [cx, cy, r]. */
export const BRAND_MARK_CIRCLES = Object.freeze([[64, 72, 27], [100, 78, 25], [80, 106, 24]]);

/**
 * Das Zeichen als SVG-Markup. Dekorativ: der Name steht immer daneben, der
 * Aufrufer setzt `aria-hidden` an seinen Traeger.
 *
 * Die Verlaufs-ID ist je Aufruf neu: zwei Marken im selben Dokument
 * (Seitenleiste und ein Dialog) duerfen sich keine teilen - verschwindet die
 * erste, verliert sonst die zweite ihre Fuellung.
 *
 * @returns {string}
 */
export function brandMarkSvg() {
  seq += 1;
  const id = `yuvomi-brand-mark-${seq}`;
  const circles = BRAND_MARK_CIRCLES
    .map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`)
    .join('');
  return `<svg class="brand-mark" viewBox="0 0 160 160" fill="none" aria-hidden="true" focusable="false">`
    + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="160" y2="160" gradientUnits="userSpaceOnUse">`
    + `<stop class="brand-mark__from" offset="0%"/><stop class="brand-mark__to" offset="100%"/>`
    + `</linearGradient></defs>`
    + `<rect width="160" height="160" rx="36" fill="url(#${id})"/>`
    + `<g class="brand-mark__circles">${circles}</g>`
    + `</svg>`;
}
