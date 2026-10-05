/**
 * Modul: FLIP fuer neu gezeichnete Listen (Re-Critique 2026-09-28, P11 Kueche)
 * Zweck: Eine Liste, die ihre Zeilen neu baut (Einkauf nach dem Abgleich,
 *        Vorrat nach einer Mengenaenderung), liess jede Zeile an ihre neue
 *        Stelle SPRINGEN - ein abgehakter Artikel war ploetzlich am Gruppenende,
 *        ohne dass das Auge den Weg sah (A4 P2-8). FLIP (First, Last, Invert,
 *        Play) haelt die Lage VOR dem Neubau fest, misst danach und laesst jede
 *        Zeile, die sich bewegt hat, von ihrer alten Stelle an die neue gleiten.
 *
 * WARUM UEBER EINEN SCHLUESSEL UND NICHT UEBER DAS ELEMENT: die Listen bauen
 * neue Knoten (`insertAdjacentHTML`), das alte Element gibt es danach nicht
 * mehr. Wiedererkannt wird eine Zeile an ihrem Datenattribut (z.B.
 * `data-swipe-id`); eine Zeile ohne Vorher-Lage (neu hinzugekommen) bewegt
 * sich nicht - fuer sie gibt es die Einblendung des Aufrufers.
 *
 * Nur `transform`, Dauer und Kurve aus den Tokens (`--duration-md`,
 * `--ease-out`); unter `prefers-reduced-motion` springt die Liste wie bisher.
 */
// Relativ (wie utils/sortable.js): dieselbe Modul-URL im Browser, ladbar ohne Loader.
import { durationToken, easingToken } from './ux.js';

/**
 * Erste Messung: die Lage jeder Zeile vor dem Neubau.
 * @param {ParentNode|null} root
 * @param {string} selector - welche Elemente wandern (z.B. '.swipe-row[data-swipe-id]')
 * @param {string} keyAttr - das Attribut, an dem die Zeile wiedererkannt wird
 * @returns {Map<string, {left:number, top:number}>}
 */
export function flipSnapshot(root, selector, keyAttr) {
  const rects = new Map();
  if (!root?.querySelectorAll) return rects;
  for (const el of root.querySelectorAll(selector)) {
    const key = el.getAttribute?.(keyAttr);
    if (key == null || key === '') continue;
    const r = el.getBoundingClientRect();
    rects.set(key, { left: r.left, top: r.top });
  }
  return rects;
}

/**
 * Zweite Messung und Abspielen: jede wiedererkannte Zeile, die sich um
 * mindestens einen Pixel bewegt hat, gleitet von der alten Lage in die neue.
 * @param {ParentNode|null} root
 * @param {string} selector
 * @param {string} keyAttr
 * @param {Map<string, {left:number, top:number}>} before - aus flipSnapshot()
 * @param {{duration?: number, easing?: string}} [opts]
 * @returns {number} wie viele Zeilen gleiten
 */
export function flipPlay(root, selector, keyAttr, before, {
  duration = durationToken('--duration-md', 200),
  easing = easingToken('--ease-out', 'ease-out'),
} = {}) {
  if (!root?.querySelectorAll || !before?.size) return 0;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
  let moved = 0;
  for (const el of root.querySelectorAll(selector)) {
    const prev = before.get(el.getAttribute?.(keyAttr));
    if (!prev || typeof el.animate !== 'function') continue;
    const now = el.getBoundingClientRect();
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'none' },
    ], { duration, easing });
    moved += 1;
  }
  return moved;
}
