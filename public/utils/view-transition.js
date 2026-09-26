/**
 * Modul: Seitenwechsel als View Transition
 * Zweck: Der Router tauscht den Seiteninhalt in EINEM Schritt, und das Bild
 *        dazwischen macht der Browser - alter Inhalt blendet in den neuen, das
 *        Chrome steht.
 *
 * WARUM (Critique 2026-09-26, P2-1): der Router ersetzte den alten Inhalt
 * sofort und startete den neuen bei `opacity: 0`. Dazwischen stand ein leerer
 * Frame (gemessen nach 38ms: Deckkraft 0,00), danach schwang der Inhalt mit der
 * Glas-Feder 2px ueber sein Ziel, und in der Kueche glitt die angetippte
 * Tab-Leiste mit, weil sie Teil der neuen Seite ist. Apple wechselt Tabs ohne
 * Slide: Navigation, Kopf und Tab-Leisten STEHEN, nur der Inhalt wechselt.
 *
 * WAS STEHT, bekommt einen `view-transition-name` und wird damit aus dem
 * Wurzelbild herausgeloest (Regeln in layout.css, Abschnitt Seiten-Uebergang):
 *   - Seitenleiste und untere Kapsel: per CSS, sie sind je einmal da. Sie
 *     zeigen waehrend des Wechsels nur ihr LEBENDES neues Bild - die Pille der
 *     Kapsel gleitet dort schon seit dem Tipp (updateNav in router.js), ein
 *     eingefrorenes altes Bild darueber waere ein Geisterbild.
 *   - Die Kuechen-Leiste: per CSS (kitchen-tabs.css); sie ist sogar derselbe
 *     Knoten vorher und nachher (utils/kitchen-tabs.js), ihre Kapsel gleitet
 *     live.
 *   - Der Seitenkopf `.page-toolbar`: HIER per Inline-Stil, und nur der erste
 *     im Inhalt. Ein Name darf je Zustand nur EINMAL vorkommen, sonst verwirft
 *     der Browser die ganze Transition - und manche Seiten tragen einen
 *     zweiten Kopf (`.page-toolbar--in-group` unter der Kuechen-Leiste).
 *     Sein Inhalt blendet ueber, der Kopf selbst gleitet nicht.
 *
 * OHNE API (oder unter reduzierter Bewegung, oder im verdeckten Tab) tauscht
 * der Router direkt; der Rueckfall ist eine reine Blende ohne Versatz
 * (`.page-transition--in` in layout.css).
 */

const TOOLBAR_NAME = 'page-toolbar';

/** Pfad, von dem der laufende Seitenwechsel kommt - null beim Kaltstart. */
let _from = null;
/** Zaehlt die Wechsel; nur der juengste raeumt den Kopfnamen ab. */
let _generation = 0;

/**
 * Woher die gerade gerenderte Seite kam. Fuer Bauteile, die ueber den Wechsel
 * hinweg stehen bleiben wollen (die Kuechen-Leiste gleitet nur, wenn man aus
 * der Kueche kommt).
 * @returns {string|null}
 */
export function navigationFrom() {
  return _from;
}

/**
 * Ob der Browser den Wechsel als View Transition zeigen kann und soll.
 * @returns {boolean}
 */
export function canViewTransition() {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') return false;
  // Verdeckt ueberspringt der Browser ohnehin (InvalidStateError); die Abfrage
  // spart nur die Ausnahme.
  if (document.visibilityState === 'hidden') return false;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return true;
}

function nameToolbar(root) {
  const toolbar = root?.querySelector?.('.page-toolbar') ?? null;
  if (toolbar) toolbar.style.viewTransitionName = TOOLBAR_NAME;
  return toolbar;
}

/**
 * Fuehrt den Inhaltstausch aus - als View Transition, wenn moeglich.
 *
 * `update` laeuft in beiden Faellen genau einmal und synchron zu Ende, bevor
 * das zurueckgegebene Promise aufloest; Fehler daraus kommen dort an.
 *
 * @param {() => void} update      tauscht den Inhalt (synchroner Teil des Renders)
 * @param {object}     opts
 * @param {Element}    opts.content  der Scrollport, dessen Inhalt getauscht wird
 * @param {string|null} opts.from    Pfad vor dem Wechsel
 * @param {boolean}    opts.animate  false beim Kaltstart
 * @returns {Promise<{ transition: boolean, finished: Promise<void> }>}
 */
export async function swapPage(update, { content, from = null, animate = true } = {}) {
  _from = from;

  if (!animate || !canViewTransition()) {
    update();
    return { transition: false, finished: Promise.resolve() };
  }

  const generation = ++_generation;
  const oldToolbar = nameToolbar(content);
  let newToolbar = null;
  const transition = document.startViewTransition(() => {
    // Der alte Kopf faellt mit dem Tausch ohnehin aus dem Dokument; der Name
    // geht trotzdem vorher weg, falls eine Seite ihren Kopf wiederverwendet.
    if (oldToolbar) oldToolbar.style.viewTransitionName = '';
    update();
    newToolbar = nameToolbar(content);
  });
  // `ready` lehnt ab, wenn der Browser die Transition verwirft (doppelter
  // Name, verdeckter Tab) - das ist kein Fehler des Wechsels, der Tausch
  // selbst laeuft trotzdem.
  transition.ready.catch(() => {});
  const finished = transition.finished
    .catch(() => {})
    .finally(() => {
      // Temporaer: ein stehengebliebener Name kollidierte beim naechsten
      // Wechsel mit einem zweiten Kopf derselben Seite. Nur der juengste
      // Wechsel raeumt auf: verwirft ein zweiter Tipp diese Transition, loest
      // `finished` auf, bevor der zweite sein altes Bild aufnimmt - und derselbe
      // Kopf-Knoten traegt dann schon dessen Namen.
      if (newToolbar && generation === _generation) newToolbar.style.viewTransitionName = '';
    });
  // Wirft, wenn `update` wirft - der Router faengt es in seinem catch.
  await transition.updateCallbackDone;
  return { transition: true, finished };
}
