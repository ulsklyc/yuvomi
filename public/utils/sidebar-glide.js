/**
 * Modul: Seitenleiste ein- und ausklappen ohne Layout je Frame
 * Zweck: Der Umschalter der Seitenleiste (ab 1024px) liess `width` der Tafel
 *        und `margin-left` des Inhalts 400 ms per Transition laufen - der
 *        ganze Inhalt wurde in jedem Frame neu ausgelegt (gemessen 1440x900:
 *        17 verschiedene Inhaltsbreiten je Umschalten, Layout-Shift-Summe 0,20
 *        an `#main-content`; Critique R24 G0-Shell-P3-7).
 *
 * JETZT EIN LAYOUT UND EINE VIEW TRANSITION (Guide same-document-transitions).
 * Der Zustand wechselt in einem Frame (`apply`), Rand und Breite stehen sofort
 * am Ziel. Tafel und Inhalt tragen fuer die Dauer des Wechsels je einen Namen
 * (`html.sidebar-gliding`, layout.css); der Browser fuehrt ihre Kanten von der
 * alten an die neue Lage, die Bilder darin werden nicht gestaucht
 * (`object-fit: none`, links verankert) und blenden ineinander. Gestaucht
 * waeren die Zeichen der schmalen Tafel und jede Zeile des Inhalts.
 *
 * Ein FLIP per `transform` auf dem Inhalt (erste Fassung) traegt hier nicht:
 * der Inhalt ist in sich zentriert und rechtsbuendig gegliedert - der Titel
 * rueckt um 144 statt 164px, die Werkzeuge rechts sprangen erst aus dem Bild
 * und glitten dann zurueck.
 *
 * Dauer und Kurve aus den Motion-Tokens (layout.css). Reduzierte Bewegung,
 * Browser ohne API und ein laufender Seitenwechsel: der Wechsel steht.
 */

let running = null;

/**
 * @param {() => void} apply - setzt den Zustand (Klasse an <html>)
 * @param {{ doc?: Document }} [opts]
 * @returns {Promise<void>} loest auf, wenn der Wechsel steht
 */
export function glideSidebar(apply, { doc = document } = {}) {
  const root = doc.documentElement;
  const win = doc.defaultView ?? globalThis.window;
  const reduce = win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const sidebar = doc.querySelector('.nav-sidebar');
  // Ein zweiter Tipp waehrend des ersten, ein Seitenwechsel (er traegt die
  // Namen der Leiste selbst) und eine Leiste ohne Box gleiten nicht.
  if (reduce || running || typeof doc.startViewTransition !== 'function'
    || doc.visibilityState === 'hidden'
    || root.classList.contains('page-swapping')
    || !sidebar?.getClientRects().length) {
    apply();
    return Promise.resolve();
  }
  root.classList.add('sidebar-gliding');
  const transition = doc.startViewTransition(apply);
  running = transition;
  transition.ready?.catch?.(() => {});
  return Promise.resolve(transition.finished)
    .catch(() => {})
    .finally(() => {
      if (running === transition) running = null;
      root.classList.remove('sidebar-gliding');
    });
}
