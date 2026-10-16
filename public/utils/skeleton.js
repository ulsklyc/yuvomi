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

/**
 * Skelett fuer eine DIAGRAMM-Flaeche (R16, Bewegung): Titelzeile, darunter ein
 * Block in Diagrammhoehe, darunter eine kurze Legendenzeile. Die Statistik
 * zeigte beim Laden ein Listen-Skelett (vier Karten mit zwei Zeilen) - die
 * falsche Form: was danach kommt, sind Diagramme, und die Flaeche sprang beim
 * Eintreffen der Daten in eine andere Gliederung.
 *
 * @param {object} [opts]
 * @param {number} [opts.charts=2] - Anzahl der Diagramm-Karten
 * @returns {string} HTML-String
 */
export function renderSkeletonChart({ charts = 2 } = {}) {
  const count = Math.max(1, Math.floor(charts));
  let cards = '';
  for (let i = 0; i < count; i++) {
    cards += '<div class="skeleton-card">'
      + '<div class="skeleton skeleton-line skeleton-line--title"></div>'
      + '<div class="skeleton skeleton-chart"></div>'
      + '<div class="skeleton skeleton-line skeleton-line--short"></div>'
      + '</div>';
  }
  return `<div class="skeleton-list" aria-hidden="true">${cards}</div>`;
}

/**
 * Legt ein Skelett in einen LEEREN Traeger, das von selbst geht, sobald der
 * Inhalt kommt (Critique R19, 2026-10-16).
 *
 * Das Muster, das es ablöst: die Einstellungs-Shell legte nach 120 ms ein
 * Skelett in jeden noch leeren Abschnitt. Ein Abschnitt, der sich zuerst
 * leert, dann wartet und danach per `insertAdjacentHTML('beforeend')` anhaengt
 * (modules-active.js), haengte seinen Inhalt HINTER das Skelett - es blieb ueber
 * dem fertigen Inhalt stehen, natuerlich in etwa 2 von 10 Laeufen, mit
 * verzoegerter Antwort fast immer. Den Fehler im Abschnitt zu beheben hiesse,
 * jeden Abschnitt einzeln zu kennen; hier raeumt das Skelett sich selbst.
 *
 * WIE: ein MutationObserver am Traeger. Sobald irgendein anderer Knoten darin
 * steht, nimmt er das Skelett heraus. Sein Rueckruf laeuft als Mikrotask, also
 * vor dem naechsten Bild: Skelett und Inhalt stehen nie gemeinsam auf dem
 * Schirm. Leert der Abschnitt den Traeger selbst (`replaceChildren`), ist das
 * Skelett ohnehin weg und der Beobachter hoert auf.
 *
 * @param {Element} host - der Traeger; nur wenn er im Dokument steht und leer ist
 * @param {string} html - Markup mit GENAU einem Wurzelelement (renderSkeletonList)
 * @param {object} [env]
 * @param {typeof MutationObserver} [env.Observer] - fuer Tests
 * @returns {Element|null} das gelegte Skelett, oder null
 */
export function placeSkeletonUntilContent(host, html, { Observer = globalThis.MutationObserver } = {}) {
  if (!host?.isConnected || host.firstChild) return null;
  host.insertAdjacentHTML('beforeend', html);
  const skeleton = host.lastElementChild;
  if (!skeleton || typeof Observer !== 'function') return skeleton ?? null;
  const observer = new Observer(() => {
    if (skeleton.parentNode !== host) {
      observer.disconnect();
      return;
    }
    for (const node of host.childNodes) {
      if (node !== skeleton) {
        skeleton.remove();
        observer.disconnect();
        return;
      }
    }
  });
  observer.observe(host, { childList: true });
  return skeleton;
}
