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
 *   - Seitenleiste und untere Kapsel: per CSS unter `html.page-swapping`, und
 *     NUR fuer die Dauer des Wechsels. Sie zeigen dort nur ihr LEBENDES neues
 *     Bild - die Pille der Kapsel gleitet schon seit dem Tipp (updateNav in
 *     router.js), ein eingefrorenes altes Bild darueber waere ein Geisterbild.
 *     Dauerhaft darf der Name nicht stehen (Re-Critique 2026-09-28, A1 P1-1):
 *     er macht die Leiste zur Backdrop Root, und der `backdrop-filter` der
 *     Kapsel darin sah nur noch den transparenten Elternknoten - Schrift lief
 *     scharf zwischen den Tab-Labels durch. Guard: test-motion.js (8).
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
/** Klasse an <html>, unter der Seitenleiste und Kapsel ihren Namen tragen. */
const SWAPPING_CLASS = 'page-swapping';

/** Klasse an <html> fuer die Dauer eines Theme-Wechsels (kein Chrome-Name). */
const THEME_CLASS = 'theme-swapping';

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
  // VOR startViewTransition: der Browser nimmt das alte Bild gleich danach auf,
  // und ohne Namen blendete die Leiste dort mit der Wurzel.
  document.documentElement?.classList.add(SWAPPING_CLASS);
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
  // Ein Tipp beendet die Blende. Solange eine Wurzel-Transition laeuft, trifft
  // Chromium jeden Zeiger nur auf <html> - `::view-transition { pointer-events:
  // none }` aendert daran nichts (gemessen 2026-09-27: Seitenleisten-Tipps 30
  // und 110ms nach dem Wechsel verpufften alle). Der Tipp, der hier abbricht,
  // hat sein Ziel schon als <html> getroffen und bleibt verloren; jeder weitere
  // erreicht die neue Seite, statt bis zum Ende der Blende (~250-470ms) ins
  // Leere zu gehen.
  const skipOnTap = () => transition.skipTransition();
  document.addEventListener?.('pointerdown', skipOnTap, { capture: true, once: true });
  const finished = transition.finished
    .catch(() => {})
    .finally(() => {
      document.removeEventListener?.('pointerdown', skipOnTap, { capture: true });
      // Temporaer: ein stehengebliebener Name kollidierte beim naechsten
      // Wechsel mit einem zweiten Kopf derselben Seite. Nur der juengste
      // Wechsel raeumt auf: verwirft ein zweiter Tipp diese Transition, loest
      // `finished` auf, bevor der zweite sein altes Bild aufnimmt - und derselbe
      // Kopf-Knoten traegt dann schon dessen Namen.
      if (generation !== _generation) return;
      if (newToolbar) newToolbar.style.viewTransitionName = '';
      // Erst jetzt ist die Leiste keine Backdrop Root mehr - das Glas blurrt.
      document.documentElement?.classList.remove(SWAPPING_CLASS);
    });
  // Wirft, wenn `update` wirft - der Router faengt es in seinem catch.
  await transition.updateCallbackDone;
  return { transition: true, finished };
}


/**
 * Fuehrt einen GEWAEHLTEN Theme-Wechsel aus - als Blende ueber die Wurzel, wo
 * der Browser sie kann (Critique R18: hell <-> dunkel schlug in einem Frame um,
 * jede Flaeche einzeln).
 *
 * Kein Name, kein Chrome, das steht: das ganze Dokument blendet vom alten ins
 * neue Bild, in der Dauer der Seitenblende (`::view-transition-*(root)` in
 * layout.css). `page-swapping` bleibt aus - die Leisten wechseln ihre Farbe
 * mit und duerfen nicht als lebendes Bild ueber einem alten Grund stehen.
 *
 * NUR FUER DIE WAHL IN DEN EINSTELLUNGEN. Der Nachtwechsel des Wandmodus
 * (utils/wall-mode.js) schaltet ohne Blende: dort schaut niemand hin, und eine
 * Blende an einem Wandtablett ist eine Bewegung ohne Anlass.
 *
 * `update` laeuft genau einmal. Ohne API, im verdeckten Tab und unter
 * reduzierter Bewegung synchron (ein Fehler daraus kommt beim Aufrufer an),
 * sonst im Callback der Transition.
 *
 * @param {() => void} update  setzt das Theme
 * @returns {Promise<void>} aufgeloest, wenn die Blende durch ist
 */
export function swapTheme(update) {
  if (!canViewTransition()) {
    update();
    return Promise.resolve();
  }
  const root = document.documentElement;
  root?.classList.add(THEME_CLASS);
  const transition = document.startViewTransition(update);
  transition.ready?.catch?.(() => {});
  return Promise.resolve(transition.finished)
    .catch(() => {})
    .finally(() => root?.classList.remove(THEME_CLASS));
}
