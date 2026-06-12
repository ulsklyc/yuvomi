/**
 * Modul: Skeleton-Lade-Hilfen
 * Zweck: EINE geteilte Lade-Sprache für alle Module. Ersetzt modul-eigene
 *        „Lädt…"-Texte und Inline-Skeleton-Markup durch ein konsistentes,
 *        token-getriebenes Skeleton-Muster (Sichtbarkeit des Systemstatus).
 * Abhängigkeiten: keine (gibt reine HTML-Strings zurück; Caller fügen via
 *        insertAdjacentHTML/replaceChildren ein).
 *
 * Genutzte Klassen (global in layout.css definiert, also auf JEDER Seite
 * verfügbar — anders als das frühere .skeleton-line, das nur in dashboard.css
 * lebte und außerhalb des Dashboards still wirkungslos war):
 *   .skeleton            – Shimmer-Basis (prefers-reduced-motion-fest)
 *   .skeleton-list       – vertikaler Stapel aus Skeleton-Karten
 *   .skeleton-card       – eine Listen-Zeile als Karte
 *   .skeleton-line       – einzelne Textzeile
 *   .skeleton-line--title|short|medium|full – Breiten/Höhen-Varianten
 *
 * Skeletons sind rein dekorativ: Der Wrapper trägt aria-hidden="true", damit
 * Screenreader sie nicht vorlesen. Die Lade-Semantik (aria-busy) gehört an den
 * umgebenden Live-Region-Container des Callers.
 */

const LINE_WIDTHS = ['medium', 'full', 'short'];

/**
 * Eine Skeleton-Karte (eine Listen-Zeile).
 * @param {object} [opts]
 * @param {number} [opts.lines=2] Anzahl Textzeilen in der Karte (1–4 sinnvoll).
 * @returns {string} HTML
 */
export function renderSkeletonCard({ lines = 2 } = {}) {
  const count = Math.max(1, Math.floor(lines));
  let out = '';
  for (let i = 0; i < count; i++) {
    // Erste Zeile = Titel (etwas höher), restliche Breiten rotieren.
    const variant = i === 0 ? 'title' : LINE_WIDTHS[(i - 1) % LINE_WIDTHS.length];
    out += `<div class="skeleton skeleton-line skeleton-line--${variant}"></div>`;
  }
  return `<div class="skeleton-card">${out}</div>`;
}

/**
 * Liste aus N Skeleton-Karten für Listen-/Detail-Lade-Zustände.
 * @param {object} [opts]
 * @param {number} [opts.rows=5] Anzahl Karten.
 * @param {number} [opts.lines=2] Textzeilen pro Karte.
 * @returns {string} HTML (mit aria-hidden-Wrapper)
 */
export function renderSkeletonList({ rows = 5, lines = 2 } = {}) {
  const count = Math.max(0, Math.floor(rows));
  let cards = '';
  for (let i = 0; i < count; i++) cards += renderSkeletonCard({ lines });
  return `<div class="skeleton-list" aria-hidden="true">${cards}</div>`;
}
