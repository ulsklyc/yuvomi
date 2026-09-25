/**
 * Modul: Zeitraum-Wisch (geteilt)
 * Zweck: Waagerechtes Wischen ueber einer Zeitraum-Ansicht blaettert einen
 *        Zeitraum vor oder zurueck - Monat, Woche, Tag im Kalender.
 * Abhängigkeiten: utils/ux.js (vibrate), utils/swipe-row.js (Schwellen)
 *
 * WARUM (Critique 2026-09-24, P1): Vor/Zurueck lagen mobil bei y 57-105, also
 * ausserhalb der Daumenzone, und eine Geste gab es nicht. Die Pfeilknoepfe
 * bleiben der Weg fuer Tastatur und Maus; die Geste ist der fuer den Daumen.
 *
 * DIESELBEN SCHWELLEN WIE DIE WISCHZEILEN (DESIGN.md, „Wischbedienung"):
 * 80px bis zur Tat, 12px Toleranz, bevor die Richtung feststeht, Haptik am
 * Schwellwert. Wer die Geste in einer Liste gelernt hat, findet sie hier mit
 * demselben Weg wieder. Die Richtungssperre ist die der Wischzeilen: wer
 * zuerst deutlich senkrecht zieht, scrollt, und die Geste ist fuer diesen
 * Kontakt vorbei - das Zeitraster der Woche und die Agenda scrollen weiter
 * wie bisher.
 *
 * DER RAND GEHOERT DEM SYSTEM. Ein Kontakt, der naeher als 20px an einer
 * Bildschirmkante beginnt, ist die Zurueck-Geste von iOS (und die
 * Randgeste von Android) - er wird gar nicht erst angenommen, statt mit ihr
 * um denselben Finger zu konkurrieren.
 *
 * DIE ZEIT LAEUFT IN LESERICHTUNG. In LTR holt ein Wisch nach links den
 * naechsten Zeitraum herein (der Inhalt wandert nach links hinaus); in `ar`
 * und `fa` setzt die App `dir=rtl`, und dort ist es gespiegelt - dieselbe
 * Ableitung, mit der `wireSwipeRows` Anfang und Ende bestimmt.
 *
 * BEWEGUNG NUR MIT ERLAUBNIS. Unter `prefers-reduced-motion: reduce` folgt der
 * Inhalt dem Finger nicht und gleitet nicht herein; die Geste selbst bleibt
 * (sie ist Bedienung, keine Animation), der Wechsel ist ein harter Schnitt.
 */

import { vibrate } from '/utils/ux.js';
import { SWIPE_THRESHOLD, SWIPE_MAX_VERT } from '/utils/swipe-row.js';

/** Abstand zur Bildschirmkante, in dem ein Kontakt der Systemgeste gehoert. */
export const PERIOD_SWIPE_EDGE = 20;

/** Dauer des Hereingleitens = --duration-md der Keyframe-Regel in calendar.css. */
const SLIDE_IN_MS = 200;

/**
 * Gehoert ein Kontakt, der bei `x` beginnt, der Randgeste des Systems?
 * @param {number} x      - clientX des Kontakts
 * @param {number} width  - Breite des Viewports
 */
export function startsAtScreenEdge(x, width) {
  return x < PERIOD_SWIPE_EDGE || x > width - PERIOD_SWIPE_EDGE;
}

/**
 * Richtungssperre: `'swipe'`, `'scroll'` oder `null` (noch unentschieden).
 * Dieselbe Regel wie in wireSwipeRows - senkrecht gewinnt, sobald es mehr
 * senkrecht als waagerecht ist und die Toleranz ueberschreitet.
 */
export function periodSwipeLock(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay > SWIPE_MAX_VERT && ax < ay) return 'scroll';
  if (ax > SWIPE_MAX_VERT && ax >= ay) return 'swipe';
  return null;
}

/**
 * Welcher Schritt folgt aus einem Wischweg? +1 = naechster Zeitraum,
 * -1 = vorheriger, 0 = zu kurz (federt zurueck).
 * @param {number} dx          - waagerechter Weg (clientX-Differenz)
 * @param {{ rtl?: boolean }} [opts]
 */
export function periodSwipeStep(dx, { rtl = false } = {}) {
  if (Math.abs(dx) < SWIPE_THRESHOLD) return 0;
  const towardsStart = dx < 0; // physisch nach links
  const next = rtl ? !towardsStart : towardsStart;
  return next ? 1 : -1;
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isRtl(el) {
  return (el.closest('[dir]')?.getAttribute('dir') || document.documentElement.dir) === 'rtl';
}

/**
 * Ein offener Dialog nimmt der Flaeche darunter die Geste - dieselbe Probe wie
 * in wireSwipeRows. NICHT `[aria-modal="true"]`: das „Mehr"-Blatt und das
 * Such-Overlay der Shell tragen es dauerhaft, auch geschlossen, und haetten
 * die Geste still auf jeder Seite abgeschaltet (gemessen beim Bau).
 */
function overlayOpen() {
  return Boolean(document.getElementById('shared-modal-overlay'));
}

/**
 * Verdrahtet die Geste auf `surface` (einem Element, das ueber die Renders
 * hinweg bestehen bleibt; seine KINDER werden je Zeitraum ersetzt).
 *
 * @param {HTMLElement} surface
 * @param {Object} opts
 * @param {() => boolean} opts.enabled        - gilt die Geste gerade (Ansicht, Suche)?
 * @param {(step: 1 | -1) => Promise<void>|void} opts.onStep - blaettert und rendert neu
 * @param {string} [opts.ignore]              - Selektor, an dem die Geste einem anderen Zweck gehoert
 * @returns {() => void} Abbau
 */
export function wirePeriodSwipe(surface, { enabled, onStep, ignore } = {}) {
  if (!surface) return () => {};
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let lock = null;       // null = unentschieden, 'swipe' | 'scroll' | 'off'
  let thresholdHit = false;
  let moving = null;     // das Element, das dem Finger folgt

  const reset = (animate) => {
    const el = moving;
    moving = null;
    if (!el) return;
    if (animate && !prefersReducedMotion()) {
      el.style.transition = `transform ${SLIDE_IN_MS}ms var(--ease-out)`;
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; el.style.willChange = ''; }, SLIDE_IN_MS);
    } else {
      el.style.transition = '';
      el.style.transform = '';
      el.style.willChange = '';
    }
  };

  const onStart = (e) => {
    // Ein weiterer Finger mitten im Wisch bricht ihn HIER ab: nach dem
    // lock = 'off' darunter erreicht onMove seinen Mehrfinger-Zweig nie mehr,
    // und der Inhalt bliebe verschoben stehen (PR #1460, Review).
    if (moving) reset(true);
    lock = 'off';
    if (e.touches.length !== 1) return;
    if (enabled && !enabled()) return;
    if (overlayOpen()) return;
    if (ignore && e.target.closest?.(ignore)) return;
    const touch = e.touches[0];
    if (startsAtScreenEdge(touch.clientX, window.innerWidth)) return;
    startX = touch.clientX;
    startY = touch.clientY;
    dx = 0;
    thresholdHit = false;
    lock = null;
  };

  const onMove = (e) => {
    if (lock === 'off' || lock === 'scroll') return;
    if (e.touches.length !== 1) { lock = 'off'; reset(true); return; }
    const touch = e.touches[0];
    dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (lock === null) {
      lock = periodSwipeLock(dx, dy);
      if (lock !== 'swipe') return;
      moving = prefersReducedMotion() ? null : surface.firstElementChild;
      if (moving) moving.style.willChange = 'transform';
    }
    // Ab hier gehoert der Kontakt der Geste: kein senkrechtes Mitscrollen.
    if (e.cancelable) e.preventDefault();

    if (moving) {
      // Bis zur Schwelle 1:1, darueber gedaempft - dasselbe Gefuehl wie in
      // den Wischzeilen: der Inhalt sagt „gleich", bevor er „jetzt" sagt.
      const sign = Math.sign(dx);
      const abs = Math.abs(dx);
      const shown = abs <= SWIPE_THRESHOLD ? abs : SWIPE_THRESHOLD + (abs - SWIPE_THRESHOLD) * 0.2;
      moving.style.transform = `translateX(${sign * shown}px)`;
    }
    if (!thresholdHit && Math.abs(dx) >= SWIPE_THRESHOLD) {
      thresholdHit = true;
      vibrate(15);
    }
  };

  const onEnd = async () => {
    if (lock !== 'swipe') { lock = 'off'; return; }
    lock = 'off';
    const step = periodSwipeStep(dx, { rtl: isRtl(surface) });
    if (!step) { reset(true); return; }
    // Der alte Inhalt bleibt stehen, wo der Finger ihn losliess, bis der neue
    // Zeitraum geladen ist - ein Zurueckschnappen davor saehe aus wie ein
    // abgelehnter Wisch. Laesst der Neuaufbau ihn stehen (Ladefehler), muss
    // sein Transform trotzdem weg.
    const outgoing = moving;
    moving = null;
    try {
      await onStep(step);
    } finally {
      if (outgoing?.isConnected) {
        outgoing.style.transition = '';
        outgoing.style.transform = '';
        outgoing.style.willChange = '';
      }
    }
    if (prefersReducedMotion()) return;
    const incoming = surface.firstElementChild;
    if (!incoming) return;
    const cls = step > 0 ? 'period-swipe-in--next' : 'period-swipe-in--prev';
    incoming.classList.add(cls);
    setTimeout(() => incoming.classList.remove(cls), SLIDE_IN_MS);
  };

  const onCancel = () => { lock = 'off'; reset(false); };

  surface.addEventListener('touchstart', onStart, { passive: true });
  surface.addEventListener('touchmove', onMove, { passive: false });
  surface.addEventListener('touchend', onEnd, { passive: true });
  surface.addEventListener('touchcancel', onCancel, { passive: true });
  return () => {
    surface.removeEventListener('touchstart', onStart);
    surface.removeEventListener('touchmove', onMove);
    surface.removeEventListener('touchend', onEnd);
    surface.removeEventListener('touchcancel', onCancel);
  };
}
