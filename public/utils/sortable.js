/**
 * Modul: Sortable-Wrapper (Drag-and-Drop-Reihenfolge)
 * Zweck: Projektweit einheitliche Kapselung von SortableJS (vendored unter
 *        /vendor/sortablejs/) für Drag-Handle-basiertes, touch-sicheres Umsortieren.
 * Abhängigkeiten: /vendor/sortablejs/sortable.esm.min.js (lazy), /utils/ux.js
 *
 * Drag ist NIE der einzige Weg: jede Liste, die diesen Wrapper nutzt, muss
 * daneben einen tastaturbedienbaren Reorder-Pfad (z. B. Auf/Ab-Buttons)
 * behalten, der denselben Persistenz-Handler aufruft.
 */
import { vibrate } from './ux.js';

let sortablePromise = null;
function loadSortable() {
  if (!sortablePromise) {
    sortablePromise = import('/vendor/sortablejs/sortable.esm.min.js').then((mod) => mod.default);
  }
  return sortablePromise;
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Aktiviert Drag-and-Drop-Sortierung für die Kinder von `listEl`.
 * Lädt SortableJS lazy nach; ohne `listEl` oder `onEnd` passiert nichts.
 *
 * @param {HTMLElement} listEl - Container, dessen Kind-Elemente sortierbar werden
 * @param {object} opts
 * @param {string} opts.handle - CSS-Selektor des Drag-Handles innerhalb jeder Zeile
 * @param {string} [opts.draggable] - CSS-Selektor der tatsächlich sortierbaren Zeilen
 *        (z. B. wenn eine Add-Zeile im selben Container mitgerendert wird)
 * @param {(evt: object) => void|Promise<void>} opts.onEnd - Callback nach Drop;
 *        bekommt das rohe SortableJS-Event (item, oldIndex, newIndex, ...)
 * @returns {Promise<object|null>} die Sortable-Instanz (zum späteren `.destroy()`) oder null
 */
export async function makeSortable(listEl, { handle, draggable, onEnd } = {}) {
  if (!listEl || typeof onEnd !== 'function') return null;
  const Sortable = await loadSortable();
  const reduced = prefersReducedMotion();
  return Sortable.create(listEl, {
    handle,
    draggable,
    animation: reduced ? 0 : 150,
    easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    delay: 120,
    delayOnTouchOnly: true,
    touchStartThreshold: 5,
    // Statt nativem HTML5-DnD: eigene Maus/Touch-Simulation. Konsistentes
    // Verhalten über Browser/Eingabegeräte hinweg und volle Kontrolle über
    // ghost/chosen/drag-CSS (native DnD überschreibt das Drag-Bild sonst mit
    // einem Browser-eigenen Screenshot-Ghost).
    forceFallback: true,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    onEnd(evt) {
      if (evt.oldIndex === evt.newIndex) return;
      vibrate(15);
      onEnd(evt);
    },
  });
}

/** Liefert eine neue Liste mit dem Element von `oldIndex` an Position `newIndex`. */
export function reorder(items, oldIndex, newIndex) {
  const next = items.slice();
  const [moved] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, moved);
  return next;
}
