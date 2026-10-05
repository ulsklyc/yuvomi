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
import { vibrate, durationToken, easingToken } from './ux.js';

let sortablePromise = null;
let SortableCtor = null;
function loadSortable() {
  if (!sortablePromise) {
    sortablePromise = import('/vendor/sortablejs/sortable.esm.min.js')
      .then((mod) => { SortableCtor = mod.default; return mod.default; })
      .catch((err) => {
        // Fehlgeschlagenen Import nicht dauerhaft cachen: sonst liefert jeder
        // spätere Aufruf dieselbe abgelehnte Promise und der globale
        // unhandledrejection-Handler (router.js) zeigt bei jedem Render einen
        // Fehler-Toast. Zurücksetzen erlaubt einen erneuten Versuch.
        sortablePromise = null;
        throw err;
      });
  }
  return sortablePromise;
}

/**
 * Ob gerade irgendeine Sortable-Instanz aktiv gezogen wird. Liest das statische
 * SortableJS-Flag der (falls schon geladenen) Bibliothek — synchron, ohne den
 * lazy Import zu erzwingen (vor dem ersten makeSortable() gibt es keinen Drag).
 * @returns {boolean}
 */
export function isDragActive() {
  return !!(SortableCtor && SortableCtor.active);
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
 * @param {string} [opts.filter] - CSS-Selektor dessen, was NICHT gezogen werden
 *        darf, obwohl es zu `draggable` passt: ganze Zeilen (z. B. bereits
 *        abgehakte) ebenso wie einzelne Bedienelemente INNERHALB einer Zeile
 *        (z. B. ein Knopf, der beim langen Druck sonst die Zeile aufnähme)
 * @param {string|object} [opts.group] - Verbund mehrerer Listen, zwischen denen
 *        gezogen werden darf (SortableJS-`group`). Ohne Angabe bleibt jede Liste
 *        für sich - der Normalfall, denn ein Zug in eine fremde Liste ist meist
 *        ein Kategoriewechsel und keine Umsortierung.
 * @param {boolean} [opts.sort=true] - Ob INNERHALB einer Liste umsortiert werden
 *        darf. `false` zusammen mit `group`: die Liste ist ein Fach, kein Rang -
 *        wer keine Reihenfolge speichert, darf auch keine anbieten, sonst steht
 *        die verschobene Zeile da, bis irgendetwas anderes neu zeichnet.
 * @param {(evt: object) => void|Promise<void>} opts.onEnd - Callback nach Drop;
 *        bekommt das rohe SortableJS-Event (item, from, to, oldIndex, newIndex, ...)
 * @returns {Promise<object|null>} die Sortable-Instanz (zum späteren `.destroy()`) oder null
 */
export async function makeSortable(listEl, { handle, draggable, filter, group, sort = true, onEnd } = {}) {
  if (!listEl || typeof onEnd !== 'function') return null;
  const Sortable = await loadSortable();
  const reduced = prefersReducedMotion();
  return Sortable.create(listEl, {
    handle,
    draggable,
    filter,
    // FILTERN HEISST "NICHT ZIEHEN", NICHT "NICHT BEDIENEN". SortableJS ruft mit
    // seinem Standard `preventOnFilter: true` ein preventDefault() auf dem
    // Aufsetz-Ereignis, und auf einem Touchgerät nimmt das dem gefilterten
    // Element auch den Klick - ein Knopf, den man vom Ziehen ausnimmt, wäre
    // damit tot statt geschützt. Der Wrapper verspricht in `filter` nur das
    // eine, also tut er auch nur das eine.
    preventOnFilter: false,
    group,
    sort,
    // Dauer und Feder aus tokens.css (--duration-sm, --ease-glass): die Kurve
    // stand hier als zweite Quelle neben dem Token.
    animation: reduced ? 0 : durationToken('--duration-sm', 150),
    easing: easingToken('--ease-glass', 'ease-out'),
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
      // ZWISCHEN LISTEN ZAEHLT DER INDEX NICHT. Die Bedingung war
      // `oldIndex === newIndex` und stimmte, solange jede Liste fuer sich blieb:
      // gleicher Platz hiess dann "nichts passiert". Mit `group` (#808:
      // Aufgabenboard) ist Platz 0 in einer Spalte nicht Platz 0 in der
      // naechsten - die oberste Karte von "Offen" nach "Erledigt" haette
      // denselben Index behalten und der Drop waere still verfallen.
      //
      // Fuer jeden bisherigen Aufrufer aendert sich nichts: ohne `group` ist
      // `from === to` immer wahr, und die Bedingung liest sich wie vorher.
      if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
      vibrate(15);
      onEnd(evt);
    },
  });
}
