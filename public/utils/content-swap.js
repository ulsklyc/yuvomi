/**
 * Modul: Inhaltswechsel eines Traegers (content-swap)
 * Zweck: DER EINE Uebergang fuer "derselbe Traeger, neuer Inhalt" - Reiter-
 *        wechsel in einem Modul, Monats- und Zeitraum-Blaettern, Bereichs-
 *        wechsel. Der Traeger blendet seinen neuen Inhalt ein, auf Wunsch mit
 *        8px Versatz in Schrittrichtung.
 * Abhaengigkeiten: /utils/ux.js (Token-Leser)
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
