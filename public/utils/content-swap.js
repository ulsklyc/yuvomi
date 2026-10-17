/**
 * Modul: Inhaltswechsel eines Traegers (content-swap)
 * Zweck: DER EINE Uebergang fuer "derselbe Traeger, neuer Inhalt" - Reiter-
 *        wechsel in einem Modul, Monats- und Zeitraum-Blaettern, Bereichs-
 *        wechsel. Der Traeger blendet seinen neuen Inhalt ein, auf Wunsch mit
 *        8px Versatz in Schrittrichtung.
 * Abhaengigkeiten: /utils/ux.js (Token-Leser), /utils/view-transition.js
 *                  (geteilte Marke `html.page-swapping`)
 *
 * WARUM (Critique R16, P2 Bewegung): die App hatte dafuer zwei Einzelstuecke -
 * die Seitenblende des Routers (`swapPage`) und ein `fade-in` am Budget-
 * Reiter - und sonst harte Schnitte: Reiter in Belohnungen, Haushaltshilfe und
 * Schichtplan, der Monatswechsel im Budget, das Blaettern im Kalender am
 * Desktop (per Touch glitt es schon), der Bereichswechsel der Gesundheit.
 *
 * DIE REGELN, EINMAL:
 * - `update()` laeuft IMMER, genau einmal und synchron, bevor irgendetwas
 *   animiert. Der Endzustand haengt an keiner Animation: es gibt kein `fill`,
 *   keinen Inline-Stil und kein rAF - laeuft die Blende nicht (verdeckter Tab,
 *   kein `animate`), steht der neue Inhalt trotzdem fertig da.
 * - Nur `opacity` und `transform`. Die Blende beginnt bei 0,4 statt 0: kein
 *   leerer Frame (dieselbe Zahl wie `period-swipe-in` in layout.css).
 * - Richtung: `direction > 0` heisst "weiter" - der Inhalt kommt von der
 *   Seite, zu der man blaettert (in RTL gespiegelt), derselbe Richtungssinn
 *   wie das Wischen (utils/period-swipe.js).
 * - Reduzierte Bewegung: kein Versatz, nur eine kurze Blende.
 * - Ein neuer Aufruf am selben Traeger bricht die laufende Blende ab; nichts
 *   sperrt Eingaben, der naechste Tipp trifft schon den neuen Inhalt.
 */
// Relativ importiert (wie utils/sortable.js): im Browser dieselbe Modul-URL wie
// '/utils/ux.js', und die Unit-Tests laden die Datei ohne Loader.
import { durationToken, easingToken } from './ux.js';
import { holdPageSwapping } from './view-transition.js';

/** Versatz in Schrittrichtung, in px. */
export const SWAP_SHIFT_PX = 8;
/** Start-Deckkraft der Blende - nicht 0, sonst steht ein leerer Frame. */
export const SWAP_FROM_OPACITY = 0.4;

/** Traeger -> laufende Animation. Haelt keinen abgehaengten Traeger am Leben. */
const running = new WeakMap();

function reducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
}

function isRtl(host) {
  const own = host.closest?.('[dir]')?.getAttribute('dir');
  const doc = typeof document !== 'undefined' ? document.documentElement?.dir : '';
  return (own || doc) === 'rtl';
}

/**
 * Tauscht den Inhalt eines Traegers und blendet den neuen ein.
 *
 * @param {Element|null} host           der Traeger, dessen Inhalt wechselt
 * @param {(() => void)|null} update    tauscht den Inhalt (synchron)
 * @param {object} [opts]
 * @param {number} [opts.direction=0]   > 0 weiter, < 0 zurueck, 0 nur Blende
 * @param {boolean} [opts.animate=true] false: nur tauschen (erster Aufbau)
 * @returns {Animation|null} die gestartete Blende, sonst null
 */
export function swapContent(host, update, { direction = 0, animate = true } = {}) {
  const previous = host ? running.get(host) : null;
  if (previous) {
    running.delete(host);
    try { previous.cancel(); } catch { /* schon beendet */ }
  }

  if (typeof update === 'function') update();

  if (!host || !animate || typeof host.animate !== 'function') return null;
  // Verdeckt rendert der Browser keine Frames: eine dort gestartete Blende
  // stuende beim Zurueckkehren mitten im Lauf.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null;

  const reduced = reducedMotion();
  const step = Math.sign(Number(direction) || 0);
  const from = { opacity: SWAP_FROM_OPACITY };
  const to = { opacity: 1 };
  if (step && !reduced) {
    const shift = step * (isRtl(host) ? -1 : 1) * SWAP_SHIFT_PX;
    from.transform = `translateX(${shift}px)`;
    to.transform = 'none';
  }
  const anim = host.animate([from, to], {
    duration: reduced ? durationToken('--duration-sm', 150) : durationToken('--duration-md', 200),
    easing: easingToken('--ease-out', 'ease-out'),
  });
  running.set(host, anim);
  const release = () => { if (running.get(host) === anim) running.delete(host); };
  anim.finished?.then(release, release);
  return anim;
}

/* --------------------------------------------------------
 * GERICHTETER WECHSEL MIT ALTEM BILD (R19, Critique 2026-10-16)
 *
 * swapContent blendet nur den NEUEN Inhalt ein - das alte Bild ist da schon
 * weg. Fuer einen Ebenen- oder Ansichtswechsel reicht das nicht: der
 * Kalender-Ansichtswechsel war eine reine Blende ohne raeumliche Fortfuehrung,
 * und der Drill-down (Einstellungen, Gesundheit) liess die alte Ebene einfach
 * verschwinden. swapRegion nimmt das alte Bild per View Transition auf:
 *   - vorwaerts (+1) schiebt sich die neue Ebene von der Seite herein, die
 *     alte tritt leicht zurueck und blendet aus;
 *   - zurueck (-1) schiebt sich die alte Ebene zur Seite hinaus, die
 *     vorige kommt von leicht dahinter.
 * Regeln in layout.css (`region-swap`). Navigation, Kapsel und FAB stehen
 * (`html.page-swapping` traegt ihre Namen wie beim Seitenwechsel), der Rest
 * der Seite zeigt nur sein lebendes neues Bild - eine gleitende
 * Segment-Kapsel im Kopf laeuft also weiter, statt als Geist einzufrieren.
 *
 * Reduzierte Bewegung: kein Versatz, die Bilder blenden nur (layout.css).
 * Ohne API, ohne `:active-view-transition-type()`, im verdeckten Tab oder
 * hinter einem offenen Dialog (regionCovered): swapContent mit derselben
 * Richtung (8px, nur der neue Inhalt).
 * -------------------------------------------------------- */

/** Name der Region fuer die Dauer des Wechsels (layout.css). */
export const REGION_NAME = 'region-swap';

/** Ob der Browser den gerichteten Wechsel kann (Typen fuer die Richtung). */
export function canSwapRegion() {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') return false;
  if (document.visibilityState === 'hidden') return false;
  try {
    return typeof CSS !== 'undefined' && CSS.supports('selector(:active-view-transition-type(a))');
  } catch {
    return false;
  }
}

/**
 * Ob ueber der Region schon ein modaler Dialog liegt.
 *
 * Der Wechsel startet erst, wenn die neuen Daten da sind (Kalender:
 * `reloadForView`). Wer in dieser Zeit schon weitertippt - Ansicht "Tag", dann
 * sofort "Neuer Termin" -, hat den Dialog offen, wenn die Transition beginnt.
 * Sie liefe dann hinter dem Dialog, und solange sie laeuft, trifft Chromium
 * nur <html>: der erste Tipp IM Dialog (Speichern) verpuffte (document-guards,
 * "neue Serie bleibt sichtbar", R19). Hinter einem Dialog gibt es nichts zu
 * zeigen - die Region tauscht dort per swapContent, das keine Eingabe sperrt.
 */
export function regionCovered() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false;
  try {
    return Boolean(document.querySelector(':modal'));
  } catch {
    return false; // Engine ohne `:modal` (vor Safari 15.6)
  }
}

/** Typ der Transition je Richtung - die Namen liest layout.css. */
export function regionSwapType(direction) {
  const step = Math.sign(Number(direction) || 0);
  return step > 0 ? 'region-forward' : step < 0 ? 'region-back' : 'region-fade';
}

/**
 * Tauscht den Inhalt einer Region mit gerichtetem Uebergang.
 *
 * `update` laeuft genau einmal; mit View Transition im Callback (also einen
 * Frame spaeter), sonst sofort. Ein Fehler daraus kommt beim Aufrufer an.
 *
 * @param {Element|null} host            die Region, deren Inhalt wechselt
 * @param {() => (void|Promise<void>)} update tauscht den Inhalt
 * @param {object} [opts]
 * @param {number} [opts.direction=0]    > 0 vorwaerts/weiter, < 0 zurueck, 0 Blende
 * @returns {Promise<{ transition: boolean, finished: Promise<void> }>}
 */
export async function swapRegion(host, update, { direction = 0 } = {}) {
  if (!host || !host.isConnected || !canSwapRegion() || regionCovered()) {
    swapContent(host, update, { direction });
    return { transition: false, finished: Promise.resolve() };
  }
  // `html.page-swapping` teilt sich dieser Wechsel mit swapPage: er haelt sie
  // nur, statt sie zu besitzen (holdPageSwapping, utils/view-transition.js).
  // Startet waehrenddessen ein Seitenwechsel, nimmt das Ende von diesem ihm
  // die Chrome-Namen nicht mehr weg (Review #2049, Runde 2).
  let releaseSwapping = null;
  const mark = (on) => {
    host.style.viewTransitionName = on ? REGION_NAME : '';
    if (on) releaseSwapping = holdPageSwapping();
    else releaseSwapping?.();
  };
  mark(true);
  const transition = document.startViewTransition({
    update: () => update?.(),
    types: [regionSwapType(direction)],
  });
  transition.ready.catch(() => {});
  // Ein Tipp beendet den Wechsel: solange er laeuft, trifft Chromium nur <html>
  // (siehe utils/view-transition.js) - der naechste Tipp erreicht die Seite.
  const skip = () => transition.skipTransition();
  document.addEventListener('pointerdown', skip, { capture: true, once: true });
  const finished = Promise.resolve(transition.finished)
    .catch(() => {})
    .finally(() => {
      document.removeEventListener('pointerdown', skip, { capture: true });
      mark(false);
    });
  await transition.updateCallbackDone;
  return { transition: true, finished };
}
