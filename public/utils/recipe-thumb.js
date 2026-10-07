/**
 * Modul: Rezept-Vorschaubild
 * Zweck: Das Bild eines Provider-Rezepts (Mealie, Tandoor) als Element, mit
 *        Platzhalter, wo es keins gibt (#1059).
 * Abhaengigkeiten: utils/html.js
 *
 * Steht hier und nicht in recipes.js, weil DREI Flaechen dasselbe Bild zeigen:
 * die Rezeptliste, der Essensplaner und die Kachel "Mahlzeiten heute". Der
 * Planer und die Kachel kamen als zweite und dritte dazu (#1059 Schritt 1); eine
 * Kopie je Flaeche haette drei Orte erzeugt, an denen der Ruecksturz auf den
 * Platzhalter einzeln richtig sein muss.
 *
 * ZWEI BILDQUELLEN, EINE REIHENFOLGE (#1059 Schritt 2). Ein Rezept kann ein
 * selbst hochgeladenes Bild haben (`hasOwnImage`, Route `/recipes/:id/image`)
 * und/oder eines beim Provider (`hasImage`, Proxy-Route). DAS EIGENE GEWINNT:
 * wer eines hochlaedt, hat sich fuer genau dieses entschieden - beim
 * gespiegelten Rezept ist das eine bewusste Korrektur des Providerbildes, sonst
 * ist es die einzige Quelle. Beide fallen auf denselben Platzhalter zurueck.
 *
 * ZWEI FAELLE, DIE BEIDE VORKOMMEN:
 *
 * 1. KEIN BILD BEIM PROVIDER (`hasImage` falsch, aus dem letzten Sync). Dann
 *    sofort der Platzhalter und KEIN Request - der endete nur in einem 404, und
 *    Mealie schreibt fuer jeden davon eine Fehlerzeile in sein eigenes Log
 *    (mealie-recipes/mealie#4804). Ein Planer mit 28 bildlosen Zellen erzeugte
 *    sonst 28 fremde Logzeilen je Wochenwechsel.
 * 2. BILD WEG SEIT DEM LETZTEN SYNC. Der Request laeuft, kommt aber leer
 *    zurueck; ohne `onerror` staende das kaputte Bild-Icon des Browsers in der
 *    Zelle, bis der naechste Sync die Spalte richtigstellt. Deshalb faellt auch
 *    dieser Fall auf denselben Platzhalter.
 */

import { esc } from '/utils/html.js';

/**
 * @param {object}  opts
 * @param {number}  opts.recipeId  ID des Rezepts (nicht der Mahlzeit).
 * @param {boolean} opts.hasImage  `provider_has_image` aus dem letzten Sync.
 * @param {string}  opts.className Klasse des Rahmens; die Flaeche bringt ihre
 *   eigene Groesse mit. `<klasse>--placeholder` markiert den Platzhalter,
 *   `<klasse>-img` das Bild - dieselbe Form wie die Rezeptliste sie schon hatte.
 * @param {string} [opts.iconClass] Groessenklasse des Platzhalter-Symbols.
 * @returns {HTMLElement}
 */
/** Die Bild-URL eines Rezepts - eigenes zuerst, sonst das des Providers. */
function bildUrl(recipeId, { hasImage, hasOwnImage }) {
  if (!recipeId) return null;
  if (hasOwnImage) return `/api/v1/recipes/${Number(recipeId)}/image`;
  if (hasImage) return `/api/v1/recipes/${Number(recipeId)}/provider-thumbnail`;
  return null;
}

export function recipeThumbEl({ recipeId, hasImage, hasOwnImage, className, iconClass = 'icon-sm' }) {
  const slot = document.createElement('span');
  slot.className = className;

  const placeholder = () => {
    slot.classList.add(`${className}--placeholder`);
    slot.insertAdjacentHTML('beforeend', `<i data-lucide="utensils" class="${iconClass}" aria-hidden="true"></i>`);
  };

  const url = bildUrl(recipeId, { hasImage, hasOwnImage });
  if (!url) {
    placeholder();
    return slot;
  }

  const img = document.createElement('img');
  img.className = `${className}-img`;
  img.src = url;
  // Leeres alt: das Bild wiederholt den Titel, der daneben steht. Ein alt-Text
  // waere hier eine zweite Ansage derselben Sache.
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    img.remove();
    placeholder();
    if (window.lucide) window.lucide.createIcons({ el: slot });
  }, { once: true });
  slot.appendChild(img);
  return slot;
}

/**
 * Das Kopfbild eines Rezepts im Detail - oder `null`, wenn es kein eigenes gibt.
 *
 * KEIN PLATZHALTER (Critique 2026-10-05, R16). In der Liste haelt der
 * Platzhalter die Zeilen buendig; im Detail waere er ein grauer 3:2-Block ueber
 * den Zutaten, der nichts zeigt. Ohne Bild gibt es das Element deshalb gar
 * nicht, und ein Bild, das beim Laden scheitert, nimmt seinen Rahmen mit.
 *
 * NUR DAS EIGENE BILD. Die Provider-Route liefert ein Vorschaubild (klein
 * gerechnet); auf Detailbreite gezogen waere es unscharf. Das selbst
 * hochgeladene kommt in der Groesse, in der es gespeichert wurde.
 *
 * @param {object}  opts
 * @param {number}  opts.recipeId
 * @param {boolean} opts.hasOwnImage
 * @param {string}  [opts.className]  Klasse des Rahmens; das Bild traegt `<klasse>-img`.
 * @param {() => HTMLElement|null} [opts.fallback]  was an die Stelle des Rahmens tritt,
 *        wenn das Bild beim Laden scheitert (R18: das Band, `recipeBandEl`)
 * @returns {HTMLElement|null}
 */
export function recipeHeroEl({ recipeId, hasOwnImage, className = 'recipe-detail__hero', fallback = null }) {
  if (!recipeId || !hasOwnImage) return null;
  const frame = document.createElement('div');
  frame.className = className;
  const img = document.createElement('img');
  img.className = `${className}-img`;
  img.src = `/api/v1/recipes/${Number(recipeId)}/image`;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    const next = typeof fallback === 'function' ? fallback() : null;
    if (!next) { frame.remove(); return; }
    frame.replaceWith(next);
    if (window.lucide) window.lucide.createIcons({ el: next });
  }, { once: true });
  frame.appendChild(img);
  return frame;
}

/**
 * DER KOPF EINES REZEPTS OHNE BILD (Critique R18, 2026-10-07; Entscheidung
 * Ulas 07.10.). Das Detail eines bildlosen Rezepts begann mit Chips und einer
 * Zutatenliste - nichts sagte "Rezept". Der R16-Satz oben bleibt wahr: KEIN
 * Platzhalter, also kein grauer 3:2-Block, der ein fehlendes Foto anzeigt.
 * Dieses Band behauptet kein Bild: es ist flach (eine Zeile hoch), traegt den
 * Kuechenton und das Zeichen der ersten Mahlzeit, zu der das Rezept passt -
 * ein Kopf, kein Rahmen. Die LISTE bleibt ohne ihn.
 *
 * Das Zeichen sitzt in einem VOLLTON-SIEGEL auf der getoenten Flaeche (wie das
 * Modulsiegel): Flaeche UND Zeichen im selben blassen Ton waeren die
 * zurueckgenommene Fassung, die die Skalen-Regel verbietet (DESIGN.md, Colors).
 *
 * Schmuck: der Name steht in der Zeile, die Mahlzeiten als Chips darunter.
 *
 * @param {object} opts
 * @param {string} [opts.icon]       Lucide-Name des Mahlzeit-Zeichens
 * @param {string} [opts.className]  Klasse des Bands; das Siegel traegt `<klasse>-seal`, das Zeichen `<klasse>-icon`
 * @returns {HTMLElement}
 */
export function recipeBandEl({ icon = 'utensils', className = 'recipe-detail__band' } = {}) {
  const band = document.createElement('div');
  band.className = className;
  band.setAttribute('aria-hidden', 'true');
  const seal = document.createElement('span');
  seal.className = `${className}-seal`;
  const sign = document.createElement('i');
  sign.className = `${className}-icon`;
  sign.dataset.lucide = icon;
  seal.appendChild(sign);
  band.appendChild(seal);
  return band;
}

/**
 * Dieselbe Vorschau als HTML-Schnipsel, fuer Flaechen, die ihre Karten als
 * String bauen (Planer, Uebersichtskachel).
 *
 * WARUM ZWEI FORMEN UND NICHT EINE. Der Ruecksturz aus Fall 2 haengt an einem
 * `error`-Listener, und den kann ein String nicht mitbringen: ein `onerror="..."`
 * im Markup waere ein Inline-Handler und damit von der CSP dieser App verboten.
 * Wer diese Form benutzt, ruft nach dem Einfuegen `wireRecipeThumbs(root)` -
 * genau so, wie die Karten daneben ihre `data-action`-Knoepfe verdrahten.
 */
export function recipeThumbHtml({ recipeId, hasImage, hasOwnImage, className, iconClass = 'icon-sm' }) {
  const url = bildUrl(recipeId, { hasImage, hasOwnImage });
  if (!url) {
    return `<span class="${className} ${className}--placeholder"><i data-lucide="utensils" class="${iconClass}" aria-hidden="true"></i></span>`;
  }
  return `<span class="${className}"><img class="${className}-img" src="${esc(url)}" alt="" loading="lazy" data-recipe-thumb="${esc(className)}" data-thumb-icon="${esc(iconClass)}"></span>`;
}

/**
 * Haengt den Platzhalter-Ruecksturz an jedes Bild aus recipeThumbHtml() unter
 * `root`. Mehrfach aufrufbar: ein bereits verdrahtetes Bild traegt kein
 * `data-recipe-thumb` mehr.
 */
export function wireRecipeThumbs(root) {
  for (const img of root?.querySelectorAll?.('img[data-recipe-thumb]') ?? []) {
    const className = img.dataset.recipeThumb;
    const iconClass = img.dataset.thumbIcon || 'icon-sm';
    delete img.dataset.recipeThumb;
    delete img.dataset.thumbIcon;

    const fallback = () => {
      const slot = img.parentElement;
      img.remove();
      if (!slot) return;
      slot.classList.add(`${className}--placeholder`);
      slot.insertAdjacentHTML('beforeend', `<i data-lucide="utensils" class="${iconClass}" aria-hidden="true"></i>`);
      if (window.lucide) window.lucide.createIcons({ el: slot });
    };

    // DER LISTENER ALLEIN REICHT NICHT. Das Markup steht schon im Dokument,
    // wenn diese Funktion laeuft - der Browser hat den Request also bereits
    // gestartet, und bei einer Antwort aus dem Cache oder einem schnellen 404
    // ist das `error`-Ereignis durch, bevor hier jemand zuhoert. Ein fertiges
    // Bild ohne Masse (`complete` mit `naturalWidth === 0`) IST dieser Fall.
    if (img.complete && img.naturalWidth === 0) { fallback(); continue; }
    img.addEventListener('error', fallback, { once: true });
  }
}
