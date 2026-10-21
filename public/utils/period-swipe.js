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
 * (sie ist Bedienung, keine Animation), der neue Zeitraum blendet nur ein
 * (`period-swipe-in--fade`, R21 D2 - vorher ein harter Schnitt).
 *
 * ECHTES UMBLAETTERN (Critique R21, D2). Bis hierher zog der Finger die ganze
 * Ansicht samt Stundenachse ~110px weit gedaempft mit, daneben stand leere
 * Flaeche, und erst nach dem Loslassen und Laden kam der neue Zeitraum mit
 * einer 32px-Blende. Liefert der Aufrufer `neighbor(step)` - den vorgeladenen
 * Nachbarzeitraum als fertiges Panel -, ist die Geste ein Blaettern wie in
 * Apples Kalender: der Inhalt folgt dem Finger 1:1, der Nachbar zieht von der
 * Seite mit, Achse und Wochentagskopf (`axis`) stehen. Losgelassen rastet er
 * ab der Schwelle ODER mit Schwung ein (`periodSwipeCommit`), sonst federt
 * alles zurueck. Erst wenn der Nachbar steht, laeuft `onStep` - sein Neuaufbau
 * ersetzt das Panel an derselben Stelle, ohne sichtbaren Wechsel. Ohne
 * vorgeladenen Nachbarn (Budget, langsames Netz) bleibt es beim bisherigen Weg.
 */

import { vibrate, durationToken, easingToken } from '/utils/ux.js';
import { SWIPE_THRESHOLD, SWIPE_MAX_VERT } from '/utils/swipe-row.js';

/** Abstand zur Bildschirmkante, in dem ein Kontakt der Systemgeste gehoert. */
export const PERIOD_SWIPE_EDGE = 20;

/** Dauer des Hereingleitens = --duration-md der Keyframe-Regel in layout.css. */
const SLIDE_IN_MS = durationToken('--duration-md', 200);

/** Schwung (px/ms), mit dem auch ein kurzer Wisch umblaettert - ein Flick. */
export const PERIOD_FLICK_VELOCITY = 0.35;
/** Mindestweg eines Flicks (px): darunter ist es ein Zittern, kein Wisch. */
export const PERIOD_FLICK_MIN = 24;
/** Wie weit zurueck die Geschwindigkeit gemessen wird (ms). */
const VELOCITY_WINDOW_MS = 100;

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

/**
 * Blaettert ein losgelassener Wisch um? Ab der Schwelle immer; darunter, wenn
 * er mit Schwung in seine Richtung ging (Flick) - so blaettert man in jeder
 * Seitenansicht des Systems, und ein schneller kurzer Wisch federte sonst
 * zurueck, obwohl er gemeint war.
 * @param {number} dx        - waagerechter Weg (px)
 * @param {number} velocity  - Geschwindigkeit am Ende (px/ms, Vorzeichen wie dx)
 * @param {{ rtl?: boolean }} [opts]
 * @returns {1 | -1 | 0}
 */
export function periodSwipeCommit(dx, velocity = 0, { rtl = false } = {}) {
  const step = periodSwipeStep(dx, { rtl });
  if (step) return step;
  if (Math.abs(dx) < PERIOD_FLICK_MIN || Math.abs(velocity) < PERIOD_FLICK_VELOCITY) return 0;
  if (Math.sign(velocity) !== Math.sign(dx)) return 0;
  return periodSwipeStep(Math.sign(dx) * SWIPE_THRESHOLD, { rtl });
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

/** Die Box des Nachbarn: deckungsgleich mit dem Panel - EINE Rechnung fuer Parken und Zug. */
function ghostBox(live) {
  return {
    top: `${live.offsetTop}px`,
    left: `${live.offsetLeft}px`,
    width: `${live.getBoundingClientRect().width}px`,
    height: `${live.offsetHeight}px`,
  };
}

/**
 * Setzt nur, was sich aendert - derselbe Wert neu geschrieben verwuerfe das
 * Layout des Nachbarn. Verglichen als Zahl: das CSSOM rundet Bruchteile beim
 * Zurueckgeben (389.984375px -> 389.984px).
 */
function placeGhostBox(ghost, box) {
  for (const [key, value] of Object.entries(box)) {
    if (Math.abs((parseFloat(ghost.style[key]) || 0) - parseFloat(value)) > 0.01 || !ghost.style[key]) ghost.style[key] = value;
  }
}

/**
 * DER NACHBAR WIRD IM LEERLAUF GEPARKT, NICHT UNTER DEM FINGER EINGESETZT
 * (Critique R21 S8, Nachtrag aus D2). Eingesetzt erst bei der Sperre auf
 * „waagerecht", kostete er den ersten Zugframe: Stil und Layout seines ganzen
 * Teilbaums, im Monat dazu das Vermessen der Zellen - gemessen 4x CPU 37-48 ms
 * statt eines Frames. Geparkt steht er schon im Traeger, mit der Box des
 * Panels, unsichtbar und ohne Eingaben (`.period-swipe-ghost--parked`);
 * `onParked` richtet ihn aus (Scrollstand, Zellen), danach ruht sein Teilbaum
 * (`--rest`, content-visibility: hidden: das Layout bleibt, Stilrunden der
 * Seite rechnen ihn nicht mit). Die Geste deckt ihn nur noch auf.
 *
 * @param {HTMLElement} surface - der Traeger (dieselbe Flaeche wie bei wirePeriodSwipe)
 * @param {HTMLElement} ghost   - das Bild des Nachbarn (losgeloest, ohne ids)
 * @param {(ghost: HTMLElement, live: HTMLElement) => void} [onParked]
 * @returns {boolean} geparkt
 */
export function parkPeriodGhost(surface, ghost, onParked) {
  const live = surface?.firstElementChild;
  if (!live || !ghost || ghost === live) return false;
  ghost.classList.add('period-swipe-ghost', 'period-swipe-ghost--parked');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  placeGhostBox(ghost, ghostBox(live));
  if (ghost.parentNode !== surface) surface.appendChild(ghost);
  onParked?.(ghost, live);
  ghost.classList.add('period-swipe-ghost--rest');
  return true;
}

/**
 * Verdrahtet die Geste auf `surface` (einem Element, das ueber die Renders
 * hinweg bestehen bleibt; seine KINDER werden je Zeitraum ersetzt).
 *
 * @param {HTMLElement} surface
 * @param {Object} opts
 * @param {() => boolean} opts.enabled        - gilt die Geste gerade (Ansicht, Suche)?
 * @param {(step: 1 | -1) => Promise<boolean|void>|boolean|void} opts.onStep - blaettert und
 *   rendert neu. Liefert es `false`, hat es NICHT gezeichnet (der Schritt wurde
 *   ueberholt) - dann gleitet nichts herein. Alles andere, auch gar keine
 *   Rueckgabe, heisst: gezeichnet.
 * @param {string} [opts.ignore]              - Selektor, an dem die Geste einem anderen Zweck gehoert
 * @param {(step: 1 | -1) => HTMLElement|null} [opts.neighbor] - der vorgeladene
 *   Nachbarzeitraum als Panel (losgeloest, ohne ids). Mit ihm blaettert die Geste
 *   echt um; `null`, solange er nicht bereitsteht.
 * @param {string} [opts.axis]                - Selektor der Teile, die beim Blaettern
 *   stehen bleiben (Stundenachse, Wochentagskopf) - im Panel und im Nachbarn
 * @param {(ghost: HTMLElement, live: HTMLElement) => void} [opts.ghostMounted] -
 *   der Nachbar steht im Dokument (z. B. Scrollstand angleichen, Zellen vermessen)
 * @param {(live: HTMLElement) => number} [opts.span] - Weg eines Blatts (px); Standard
 *   die Breite des Panels. Steht eine Spalte (Stundenachse), ist es die Breite
 *   daneben - die Spalten des Nachbarn schliessen dann nahtlos an.
 * @returns {() => void} Abbau
 */
export function wirePeriodSwipe(surface, { enabled, onStep, ignore, neighbor, axis, ghostMounted, span } = {}) {
  if (!surface) return () => {};
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let lock = null;       // null = unentschieden, 'swipe' | 'scroll' | 'off'
  let thresholdHit = false;
  let moving = null;     // das Element, das dem Finger folgt
  let stepping = false;  // ein Schritt laedt noch (onStep ist nicht zurueck)
  let pager = null;      // Blaettern mit Nachbar: { live, panelWidth, width (Weg), side, ghost, axisLive, axisGhost, x }
  let samples = [];      // [zeit, x] fuer den Schwung am Ende

  const setX = (el, x) => { el.style.transform = x ? `translateX(${x}px)` : ''; };

  /** Die Seite (physisch), von der der Nachbar kommt: +1 rechts, -1 links. */
  const stepForSide = (side) => (isRtl(surface) ? -side : side);

  const dropGhost = () => {
    if (!pager?.ghost) return;
    pager.ghost.remove();
    pager.ghost = null;
    pager.axisGhost = [];
  };

  /** Holt den Nachbarn der Seite `side` und stellt ihn neben das Panel. */
  const mountGhost = (side) => {
    dropGhost();
    pager.side = side;
    const ghost = neighbor(stepForSide(side));
    if (!ghost || !pager.live.isConnected) return;
    ghost.classList.add('period-swipe-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    // Ein geparkter Nachbar (parkPeriodGhost) steht schon mit dieser Box im
    // Traeger: nicht neu einhaengen, gleiche Werte nicht neu schreiben - er
    // wird nur aufgedeckt.
    placeGhostBox(ghost, ghostBox(pager.live));
    if (ghost.parentNode !== surface) surface.appendChild(ghost);
    ghost.classList.remove('period-swipe-ghost--parked', 'period-swipe-ghost--rest');
    pager.ghost = ghost;
    pager.axisGhost = axis ? [...ghost.querySelectorAll(axis)] : [];
    ghostMounted?.(ghost, pager.live);
  };

  /** Panel, Nachbar und stehende Achsen an die Stelle x des Panels. */
  const place = (x) => {
    pager.x = x;
    setX(pager.live, x);
    for (const a of pager.axisLive) setX(a, -x);
    if (!pager.ghost) return;
    const g = pager.side * pager.width + x;
    setX(pager.ghost, g);
    for (const a of pager.axisGhost) setX(a, -g);
  };

  /**
   * Gleitet Panel (und Nachbar) nach x. Inline-Werte statt einer Animation mit
   * `fill`: am Ende steht der Zielwert im Stil, nichts bleibt haengen.
   */
  const glide = (x, ms) => new Promise((resolve) => {
    const easing = easingToken('--ease-out', 'ease-out');
    const parts = [[pager.live, x], ...pager.axisLive.map((a) => [a, -x])];
    if (pager.ghost) {
      const g = pager.side * pager.width + x;
      parts.push([pager.ghost, g], ...pager.axisGhost.map((a) => [a, -g]));
    }
    for (const [el] of parts) el.style.transition = `transform ${ms}ms ${easing}`;
    place(x);
    // Fertig ist es, wenn das Panel ankommt - nicht nach der Uhr: ein Timer,
    // der einen Frame zu frueh feuert, nahm die Transition mitten im Lauf ab.
    let done = false;
    const live = pager.live;
    const finish = () => {
      if (done) return;
      done = true;
      live.removeEventListener('transitionend', arrived);
      for (const [el] of parts) el.style.transition = '';
      resolve();
    };
    const arrived = (e) => { if (e.target === live) finish(); };
    live.addEventListener('transitionend', arrived);
    setTimeout(finish, ms + 50);
  });

  /** Raeumt das Blaettern ab - das Panel steht wieder an seinem Platz. */
  const endPaging = () => {
    if (!pager) return;
    dropGhost();
    if (pager.live.isConnected) {
      setX(pager.live, 0);
      pager.live.style.willChange = '';
      for (const a of pager.axisLive) setX(a, 0);
    }
    surface.classList.remove('is-period-paging');
    pager = null;
  };

  const reset = (animate) => {
    if (pager) {
      const p = pager;
      moving = null;
      if (animate && !prefersReducedMotion()) {
        glide(0, SLIDE_IN_MS).then(() => { if (pager === p) endPaging(); });
      } else {
        endPaging();
      }
      return;
    }
    const el = moving;
    moving = null;
    if (!el) return;
    if (animate && !prefersReducedMotion()) {
      el.style.transition = 'transform var(--duration-md) var(--ease-out)';
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
    // EIN SCHRITT ZUR ZEIT (#1775). Der Aufrufer leitet sein Ziel aus dem
    // Zeitraum ab, den er ZEIGT, und der wandert erst, wenn seine Anfragen da
    // sind: ein zweiter Wisch davor verlangte denselben Zeitraum noch einmal
    // statt des uebernaechsten, und zwei gegenlaeufige liessen stehen, was
    // zuletzt antwortete. Solange ein Schritt laedt, gehoert der Finger dem
    // Scrollen - die Geste beginnt gar nicht erst.
    if (stepping) return;
    // Federt der letzte Wisch noch zurueck, steht er jetzt - der neue beginnt
    // vom Platz des Panels, nicht neben einem uebrig gebliebenen Nachbarn.
    if (pager) endPaging();
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
    samples = [[performance.now(), touch.clientX]];
  };

  /** Geschwindigkeit am Ende (px/ms) aus den letzten VELOCITY_WINDOW_MS. */
  const velocity = () => {
    const last = samples[samples.length - 1];
    if (!last) return 0;
    const first = samples.find(([t]) => last[0] - t <= VELOCITY_WINDOW_MS) ?? last;
    const dt = last[0] - first[0];
    return dt > 0 ? (last[1] - first[1]) / dt : 0;
  };

  const onMove = (e) => {
    if (lock === 'off' || lock === 'scroll') return;
    if (e.touches.length !== 1) { lock = 'off'; reset(true); return; }
    const touch = e.touches[0];
    dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    samples.push([performance.now(), touch.clientX]);
    if (samples.length > 8) samples.shift();
    if (lock === null) {
      lock = periodSwipeLock(dx, dy);
      if (lock !== 'swipe') return;
      moving = prefersReducedMotion() ? null : surface.firstElementChild;
      if (moving) moving.style.willChange = 'transform';
      if (moving && typeof neighbor === 'function') {
        surface.classList.add('is-period-paging');
        const panelWidth = moving.getBoundingClientRect().width;
        pager = {
          live: moving,
          panelWidth,
          width: typeof span === 'function' ? span(moving) : panelWidth,
          side: 0,
          ghost: null,
          axisLive: axis ? [...moving.querySelectorAll(axis)] : [],
          axisGhost: [],
          x: 0,
        };
      }
    }
    // Ab hier gehoert der Kontakt der Geste: kein senkrechtes Mitscrollen.
    if (e.cancelable) e.preventDefault();

    if (pager) {
      // Der Nachbar kommt von der Seite, die der Finger freigibt. Kehrt der
      // Finger ueber den Anfang zurueck, wechselt er den Nachbarn.
      const side = dx < 0 ? 1 : -1;
      if (dx !== 0 && side !== pager.side) mountGhost(side);
      // Mit Nachbar 1:1 - es gibt etwas zu zeigen. Ohne (noch nicht geladen)
      // gedaempft wie bisher: der Rand sagt „hier ist noch nichts".
      const abs = Math.abs(dx);
      place(pager.ghost ? dx : Math.sign(dx) * (abs <= SWIPE_THRESHOLD ? abs : SWIPE_THRESHOLD + (abs - SWIPE_THRESHOLD) * 0.2));
    } else if (moving) {
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

  /**
   * Einrasten mit Nachbar: das Panel gleitet hinaus, der Nachbar an seinen
   * Platz - die Dauer folgt dem Rest des Wegs. Erst dann baut onStep den
   * Zeitraum wirklich auf; bis dahin steht der Nachbar dort, wo er hingehoert.
   */
  const commitPaged = async (step) => {
    const p = pager;
    stepping = true;
    const target = -p.side * p.width;
    const rest = Math.abs(target - p.x) / Math.max(1, p.width);
    const full = durationToken('--duration-lg', 250);
    await glide(target, Math.max(Math.round(full * rest), Math.round(full * 0.4)));
    let drawn;
    try {
      drawn = await onStep(step);
    } finally {
      stepping = false;
      // Gezeichnet: Panel und Nachbar sind mit dem Neuaufbau gegangen. Steht
      // das alte Panel noch (Schritt ueberholt, Ladefehler), kommt es zurueck.
      if (pager === p) {
        if (drawn === false || p.live.isConnected) endPaging();
        else { surface.classList.remove('is-period-paging'); pager = null; }
      }
    }
  };

  const onEnd = async () => {
    if (lock !== 'swipe') { lock = 'off'; return; }
    lock = 'off';
    const step = periodSwipeCommit(dx, velocity(), { rtl: isRtl(surface) });
    if (!step) { reset(true); return; }
    if (pager?.ghost) {
      moving = null;
      await commitPaged(step);
      return;
    }
    // Ohne Nachbarn: der bisherige Weg (Panel steht, Neuaufbau gleitet herein).
    if (pager) {
      const p = pager;
      dropGhost();
      surface.classList.remove('is-period-paging');
      for (const a of p.axisLive) setX(a, 0);
      pager = null;
    }
    // Der alte Inhalt bleibt stehen, wo der Finger ihn losliess, bis der neue
    // Zeitraum geladen ist - ein Zurueckschnappen davor saehe aus wie ein
    // abgelehnter Wisch. Laesst der Neuaufbau ihn stehen (Ladefehler), muss
    // sein Transform trotzdem weg.
    const outgoing = moving;
    moving = null;
    stepping = true;
    let drawn;
    try {
      drawn = await onStep(step);
    } finally {
      stepping = false;
      if (outgoing?.isConnected) {
        outgoing.style.transition = '';
        outgoing.style.transform = '';
        outgoing.style.willChange = '';
      }
    }
    // Nicht gezeichnet (#1781): im Traeger steht noch das ALTE Panel. Es als
    // "hereinkommend" zu animieren zeigte einen Wechsel, den es nicht gab.
    if (drawn === false) return;
    const incoming = surface.firstElementChild;
    if (!incoming) return;
    // Reduzierte Bewegung: kein Zug, nur Blende (D2) - kein harter Schnitt.
    const cls = prefersReducedMotion() ? 'period-swipe-in--fade'
      : step > 0 ? 'period-swipe-in--next' : 'period-swipe-in--prev';
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
