/**
 * Modul: Sheet-Ziehen (geteilt) - EINE Grammatik fuer jedes mobile Blatt.
 * Zweck: Zieh-zum-Schliessen fuer das Dialog-Sheet (components/modal.js) und
 *        das Mehr-Blatt (router.js): 1:1 mitgehen, schliessen bei Weg ODER
 *        Flick-Tempo, sonst zurueckfedern; nach oben ein Gummiband.
 *
 * WARUM GETEILT (Re-Critique 2026-09-27, P1 #1 / A1 P2-3): zwei Blaetter,
 * zwei Grammatiken. Das Mehr-Blatt schloss erst bei `touchend` ab 60px und
 * ging nicht mit; das Dialog-Sheet ging mit Faktor 0.6 mit, schloss ab 80px
 * ohne Tempo und sprang unter 80px ohne Transition zurueck. Und das Mitgehen
 * war im Normalfall gar nicht zu sehen: die Einfahrt haelt `transform` per
 * `animation-fill-mode: forwards` fest, und eine gefuellte Animation schlaegt
 * JEDES Inline-`transform` - gemessen blieb die Tafel bei
 * `style.transform = 'translateY(100px)'` auf `matrix(1,0,0,1,0,0)`.
 *
 * DESHALB `translate`, NICHT `transform`: die Einzel-Eigenschaft `translate`
 * setzt sich mit `transform` zusammen, statt es zu ersetzen. Einfahrt und
 * Ausgang (Keyframes auf `transform`) und das Ein-/Ausfahren des Mehr-Blatts
 * (Transition auf `transform`) laufen ungestoert weiter, der Zug liegt
 * darueber. Der Ausgang startet damit von selbst dort, wo der Finger das
 * Blatt losliess - `--sheet-drag` in den Keyframes ist entbehrlich.
 *
 * Die Zustandsmarke `data-sheet-drag` steuert die Transition (layout.css):
 * `drag` = keine (der Finger fuehrt), ohne Marke federt `translate` mit
 * `--duration-lg` + `--ease-out` zurueck. Reduzierte Bewegung setzt
 * reset.css auf 0s - das Blatt steht dann direkt.
 *
 * Die Geste ist Touch (touchstart/-move/-end), passiv: sie ruft nie
 * `preventDefault`, damit Scrollen im Inhalt Sache des Browsers bleibt.
 *
 * DIE GESTE WIRD ZU ENDE GEFUEHRT (Critique R18, Bewegung). Bis dahin
 * entschied das Tempo des Fingers nur Ja/Nein: nach einem Flick lief der
 * Tipp-Ausgang (`sheet-out`, 24px + Deckkraft) dort los, wo der Finger das
 * Blatt liess - es loeste sich rund 150px unter der Ruhelage am Ort auf, und
 * die Abdunklung blieb waehrend des Zugs voll. Jetzt:
 *   - SCHLIESSEN: das Blatt faehrt per Web Animations API von seiner Lage aus
 *     dem Bild, ohne sich aufzuloesen. Dauer = Reststrecke / Loslass-Tempo,
 *     geklemmt zwischen `--duration-xs` und `--duration-md` - die Obergrenze
 *     ist die Dauer des Ausgangs im Stylesheet (`--sheet-out`), nach der
 *     modal.js die Tafel abbaut; laenger floege sie ins Leere.
 *   - ZURUECKFEDERN: dieselbe Rechnung mit dem Weg zur Ruhelage, hoechstens
 *     `--duration-lg` (die Dauer der Transition, die bis dahin federte).
 *   - ABDUNKLUNG: `--sheet-pull` (0..1, Anteil des Zugs an der Blatthoehe) am
 *     Element aus `opts.dim`; das Stylesheet macht daraus `opacity`.
 * Beides animiert `translate` bzw. `opacity`, nie Layout. Der Tipp- und
 * Esc-Ausgang bleibt der kurze Hub aus dem Stylesheet (Entscheidung 05.10.).
 * Ohne `animate` oder unter reduzierter Bewegung gilt ueberall das Stylesheet.
 */
// Relativ importiert (wie utils/content-swap.js): im Browser dieselbe
// Modul-URL wie '/utils/ux.js', und die Unit-Tests laden die Datei ohne Loader.
import { durationToken, easingToken } from './ux.js';

/** Unterhalb davon entscheidet die Geste weder "ziehen" noch "scrollen" (#981). */
export const SHEET_SLOP_PX = 10;
/** Ab diesem Weg (Finger, ab Aufsetzen) schliesst das Blatt. */
export const SHEET_DISMISS_PX = 80;
/** Oder ab diesem Tempo nach unten (px/ms) - ein kurzer Flick schliesst. */
export const SHEET_FLICK_PX_PER_MS = 0.5;
/** Die Griffzone oben: von hier darf der Zug auch bei gescrolltem Inhalt starten. */
export const SHEET_HANDLE_ZONE_PX = 48;
/** Das Tempo misst die letzten Millisekunden, nicht die ganze Geste. */
const VELOCITY_WINDOW_MS = 100;
/** Obergrenze des Gummibands nach oben (px). */
const RUBBER_LIMIT_PX = 24;

/**
 * Schliessen oder zurueckfedern?
 * @param {{ distance: number, velocity: number }} g  Weg nach unten (px), Tempo (px/ms, + = abwaerts)
 */
export function shouldDismissSheet({ distance, velocity }) {
  return distance >= SHEET_DISMISS_PX || velocity > SHEET_FLICK_PX_PER_MS;
}

/**
 * Gummiband nach oben: je weiter der Finger zieht, desto weniger folgt das
 * Blatt, und es geht nie ueber RUBBER_LIMIT_PX hinaus.
 * @param {number} dy  Zug nach oben, negativ
 * @returns {number}   Versatz, negativ, |Ergebnis| < RUBBER_LIMIT_PX
 */
export function rubberBand(dy) {
  if (dy >= 0) return 0;
  const pull = -dy;
  return -(RUBBER_LIMIT_PX * pull) / (pull + RUBBER_LIMIT_PX * 2);
}

/**
 * Tempo aus den letzten Proben (px/ms, positiv = abwaerts).
 * @param {{ y: number, t: number }[]} samples
 */
export function releaseVelocity(samples) {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (last.t - samples[i].t > VELOCITY_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/**
 * Dauer einer Strecke, die der Finger angestossen hat: Weg / Tempo, geklemmt
 * in den Token-Rahmen. Ohne Tempo in Fahrtrichtung gilt die Obergrenze.
 * @param {number} distance  Reststrecke in px
 * @param {number} velocity  Tempo in Fahrtrichtung (px/ms); <= 0 zaehlt als keins
 * @param {{ min: number, max: number }} range  ms
 */
export function travelDuration(distance, velocity, { min, max }) {
  if (!(velocity > 0)) return max;
  return Math.min(max, Math.max(min, distance / velocity));
}

function reducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
}

function now(e) {
  // `timeStamp` ist bei echten Touch-Ereignissen gesetzt; Proben ohne ihn
  // (Tests, synthetische Ereignisse) fallen auf die Uhr zurueck.
  if (e && Number.isFinite(e.timeStamp) && e.timeStamp > 0) return e.timeStamp;
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function setOffset(sheet, y) {
  sheet.style.translate = y ? `0px ${y}px` : '';
}

function mark(sheet, value) {
  if (value) sheet.setAttribute('data-sheet-drag', value);
  else sheet.removeAttribute('data-sheet-drag');
}

/**
 * Verdrahtet die Zieh-Geste an einem Blatt.
 *
 * @param {HTMLElement} sheet
 * @param {object} opts
 * @param {() => (Element|null)} [opts.scroller]  der scrollende Koerper; der Zug
 *   startet nur, wenn er oben steht - oder in der Griffzone.
 * @param {() => (boolean|void)} opts.onDismiss  schliesst das Blatt. `false`
 *   zurueck heisst "bleibt stehen" (z. B. Rueckfrage bei ungespeicherten
 *   Aenderungen): dann federt das Blatt in die Ruhelage.
 * @param {number} [opts.handleZone=SHEET_HANDLE_ZONE_PX]
 * @param {() => (HTMLElement|null)} [opts.dim]  die Abdunklung hinter dem Blatt,
 *   wenn sie ein EIGENES Element ist (Backdrop des Mehr-Blatts): sie bekommt
 *   `--sheet-pull`. Das Dialog-Overlay ist Abdunklung UND Elternknoten der
 *   Tafel - seine Deckkraft naehme die Tafel mit, es bleibt deshalb aussen vor.
 * @param {boolean} [opts.resetAfterDismiss=false]  das Blatt bleibt im DOM
 *   (Mehr-Blatt): nach dem Ausfahren den Zug ohne Bewegung zuruecknehmen,
 *   sonst oeffnete es beim naechsten Mal um den alten Zug versetzt.
 * @returns {{ reset: () => void }}  `reset` nimmt einen liegengebliebenen
 *   Versatz ohne Bewegung zurueck (Mehr-Blatt beim naechsten Oeffnen).
 */
export function wireSheetDrag(sheet, {
  scroller = () => null,
  onDismiss,
  handleZone = SHEET_HANDLE_ZONE_PX,
  resetAfterDismiss = false,
  dim = () => null,
} = {}) {
  let startY = 0;
  // Hoehe des Blatts, beim Aufsetzen gemessen (dort wird ohnehin gelesen) -
  // nie im touchmove: ein Layout-Read je Bewegung.
  let height = 0;
  // Weg von der Ruhelage bis ganz aus dem Bild. Nicht immer die Blatthoehe: das
  // Mehr-Blatt schwebt UEBER der Kapsel (gemessen: Unterkante 76px ueber dem
  // Rand) - um seine Hoehe versetzt stuende es noch 52px im Bild.
  let exitDistance = 0;
  // Der laufende Flug bzw. die laufende Feder; ein neuer Zug bricht sie ab.
  let flight = null;

  const canAnimate = () => typeof sheet.animate === 'function' && !reducedMotion();

  const stopFlight = () => {
    if (!flight) return;
    try { flight.cancel(); } catch { /* schon beendet */ }
    flight = null;
  };

  /** Abdunklung dem Zug nachfuehren: Anteil des Versatzes an der Blatthoehe. */
  const setPull = (offset) => {
    const el = dim();
    if (!el?.style) return 0;
    const pull = height > 0 ? Math.min(1, Math.max(0, offset / height)) : 0;
    const rounded = Math.round(pull * 1000) / 1000;
    if (rounded > 0) el.style.setProperty('--sheet-pull', String(rounded));
    else el.style.removeProperty('--sheet-pull');
    return rounded;
  };

  /** Der aktuelle Versatz in px (aus dem Inline-Wert, den nur dieser Helfer schreibt). */
  const currentOffset = () => {
    const y = parseFloat(String(sheet.style.translate ?? '').split(' ')[1]);
    return Number.isFinite(y) ? y : 0;
  };

  let tracking = false;
  // Hat dieser Finger das Blatt schon nach unten gezogen? Erst dann gehoert
  // eine Aufwaertsbewegung zum Zug; davor ist sie Scrollen des Inhalts (#981).
  let pulled = false;
  // Beginnt der Zug in der Griffzone, gibt es keinen Inhalt, der scrollen
  // koennte - dort darf auch nach oben gezogen werden (Gummiband).
  let fromHandle = false;
  let samples = [];

  const reset = () => {
    // Der Flug haelt das Blatt draussen (`fill: forwards`) - beim Mehr-Blatt,
    // das im DOM bleibt, muss er weg, sonst oeffnete es unsichtbar.
    stopFlight();
    setPull(0);
    mark(sheet, 'drag');
    setOffset(sheet, 0);
    // Die Marke erst im naechsten Bild nehmen, sonst federte der Rueckweg.
    const clear = () => { if (sheet.getAttribute('data-sheet-drag') === 'drag') mark(sheet, null); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(clear);
    else clear();
  };

  // Das Ausfahren endet mit `transitionend` (transform, unter reduzierter
  // Bewegung opacity); der Timer faengt den Fall ohne Transition ab.
  const afterExit = (fn) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sheet.removeEventListener('transitionend', onEnd);
      fn();
    };
    const onEnd = (ev) => { if (ev.target === sheet && ev.propertyName !== 'translate') finish(); };
    sheet.addEventListener('transitionend', onEnd);
    setTimeout(finish, 600);
  };

  /**
   * In die Ruhelage zurueck. Der Zustand (kein Versatz, volle Abdunklung) steht
   * SOFORT; darueber liegt, wo es geht, eine Feder mit dem Tempo des Loslassens.
   * Solange sie laeuft, bleibt die Marke `drag` stehen: sonst liefe die
   * CSS-Transition auf `translate` darunter mit, und am Ende der kuerzeren
   * Feder spraenge das Blatt auf deren Zwischenstand. Die Marke faellt per
   * Timer - `finish` kommt im verdeckten Tab nicht verlaesslich.
   * @param {number} velocity  Tempo beim Loslassen (px/ms, + = abwaerts)
   */
  const settle = (velocity = 0) => {
    const offset = currentOffset();
    const pull = setPull(offset);
    setPull(0);
    if (!canAnimate() || offset === 0) {
      mark(sheet, null);
      setOffset(sheet, 0);
      return;
    }
    mark(sheet, 'drag');
    setOffset(sheet, 0);
    stopFlight();
    // Zurueck heisst: gegen den Versatz. Abwaerts gezogen -> Tempo nach oben zaehlt.
    const towardsRest = offset > 0 ? -velocity : velocity;
    const duration = travelDuration(Math.abs(offset), towardsRest, {
      min: durationToken('--duration-xs', 120), max: durationToken('--duration-lg', 250),
    });
    const easing = easingToken('--ease-out', 'ease-out');
    const spring = sheet.animate([{ translate: `0px ${offset}px` }, { translate: '0px 0px' }], { duration, easing });
    flight = spring;
    const el = dim();
    if (pull > 0 && typeof el?.animate === 'function') el.animate([{ opacity: 1 - pull }, { opacity: 1 }], { duration, easing });
    setTimeout(() => {
      if (flight !== spring) return;
      flight = null;
      if (sheet.getAttribute('data-sheet-drag') === 'drag' && !tracking) mark(sheet, null);
    }, duration + 20);
  };

  /**
   * Das Blatt faehrt von der Lage des Fingers aus dem Bild. Liegt UEBER dem
   * Ausgang des Stylesheets (der weiter laeuft und dessen Ende den Abbau
   * ausloest) und haelt die Deckkraft bei 1: es faehrt, es loest sich nicht auf.
   */
  const flyOut = (offset, velocity) => {
    if (!canAnimate() || !(exitDistance > offset)) return;
    stopFlight();
    const duration = travelDuration(exitDistance - offset, velocity, {
      min: durationToken('--duration-xs', 120), max: durationToken('--duration-md', 200),
    });
    flight = sheet.animate(
      [{ translate: `0px ${offset}px`, opacity: 1 }, { translate: `0px ${exitDistance}px`, opacity: 1 }],
      { duration, easing: easingToken('--ease-out', 'ease-out'), fill: 'forwards' },
    );
  };

  // Zug abbrechen, ohne zu schliessen: der Versatz federt in die Ruhelage.
  // Per rAF wie in `end` - DOM-Mutationen im Touch-Handler stoeren auf iOS
  // WebKit die Touch->Click-Konvertierung.
  const abort = () => {
    const wasPulled = tracking && pulled;
    tracking = false;
    pulled = false;
    if (!wasPulled) return;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => settle(0));
    else settle(0);
  };

  sheet.addEventListener('touchstart', (e) => {
    // Ein zweiter Finger beendet den Zug; ein schon gezogenes Blatt kehrt
    // zurueck, statt versetzt und ohne Transition-Marke stehen zu bleiben.
    if (e.touches.length !== 1) { abort(); return; }
    const y = e.touches[0].clientY;
    const box = sheet.getBoundingClientRect();
    const top = box.top;
    height = Number.isFinite(box.height) ? box.height : 0;
    const viewport = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
    exitDistance = Math.max(height, viewport - top);
    fromHandle = y - top < handleZone;
    const body = scroller();
    const atTop = !body || body.scrollTop <= 0;
    if (!fromHandle && !atTop) { tracking = false; return; }
    startY = y;
    tracking = true;
    pulled = false;
    samples = [{ y, t: now(e) }];
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const y = e.touches[0].clientY;
    const dy = y - startY;
    samples.push({ y, t: now(e) });
    if (samples.length > 12) samples.shift();

    if (dy < 0) {
      // RICHTUNGSSPERRE (#981): aufwaerts, bevor das Blatt gezogen wurde, ist
      // Scrollen des Inhalts - kein Schreibzugriff, sonst bricht iOS das
      // Scrollen ab (0-30px statt 500-675px, gemessen im Simulator). Erst
      // jenseits derselben Schwelle wie abwaerts: ein Zittern beim Aufsetzen
      // darf eine gewollte Schliessgeste nicht verwerfen.
      if (!pulled) {
        if (dy >= -SHEET_SLOP_PX) return;
        if (!fromHandle) { tracking = false; return; }
      }
      // Ein begonnener Zug (oder einer aus der Griffzone) bleibt verfolgt,
      // auch ueber den Start hinaus: dort gibt das Blatt nur widerwillig
      // nach, statt stehen zu bleiben oder dem Finger zu folgen. Aus der
      // Griffzone zaehlt der Weg ab der Schwelle, damit nichts springt.
      const up = pulled ? dy : dy + SHEET_SLOP_PX;
      pulled = true;
      stopFlight();
      mark(sheet, 'drag');
      setOffset(sheet, rubberBand(up));
      setPull(0);
      return;
    }
    // Erst ab der Schwelle ziehen - ein Tipp schreibt nichts. Danach 1:1: der
    // Versatz folgt dem Finger Pixel fuer Pixel (vorher Faktor 0.6).
    if (dy > SHEET_SLOP_PX || pulled) {
      pulled = true;
      // Ein neuer Zug uebernimmt: eine noch laufende Feder laege sonst ueber ihm.
      stopFlight();
      mark(sheet, 'drag');
      const offset = Math.max(0, dy - SHEET_SLOP_PX);
      setOffset(sheet, offset);
      setPull(offset);
    }
  }, { passive: true });

  const end = (e) => {
    if (!tracking) return;
    tracking = false;
    if (!pulled) return;
    const y = e.changedTouches?.[0]?.clientY ?? samples[samples.length - 1]?.y ?? startY;
    // Immer als Probe: ein Finger, der stillhaelt und dann loslaesst, hat
    // Tempo 0 - auch wenn die letzte Bewegung schnell war.
    samples.push({ y, t: now(e) });
    const distance = y - startY;
    const velocity = releaseVelocity(samples);
    // Aufraeumen per rAF, nie direkt im touchend: DOM-Mutationen dort
    // unterbrechen auf iOS WebKit die Touch->Click-Konvertierung, Knoepfe
    // im Blatt reagierten nicht mehr.
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => fn();
    if (distance > 0 && shouldDismissSheet({ distance, velocity })) {
      // Das Blatt bleibt, wo der Finger es liess; der Ausgang startet dort.
      mark(sheet, null);
      const leaves = onDismiss?.() !== false;
      if (!leaves) { raf(() => settle(velocity)); return; }
      // Und faehrt von dort hinaus, mit dem Tempo des Fingers (kein DOM-Schreiben:
      // die Web Animations API legt nur eine Animation an).
      flyOut(currentOffset(), velocity);
      if (resetAfterDismiss) afterExit(reset);
      return;
    }
    raf(() => settle(velocity));
  };
  sheet.addEventListener('touchend', end);
  // Ein abgebrochener Touch ist keine Schliessabsicht, auch wenn der letzte
  // Stand wie ein Flick aussah.
  sheet.addEventListener('touchcancel', abort);

  return { reset };
}
