/**
 * Modul: Swipe-Zeilen (geteilt)
 * Zweck: Wischgesten auf Listenzeilen - die Geste selbst, das Reveal-Panel
 *        darunter und der einmalige Nudge-Hinweis.
 * Abhängigkeiten: utils/ux.js (vibrate)
 *
 * WARUM GETEILT (Redesign Runde 4, C-2): dieselbe Gestenlogik stand zweimal
 * fast wortgleich in `pages/tasks.js` und `pages/shopping.js` - inklusive der
 * Schwellwerte, der Dämpfung jenseits der Schwelle, der Scroll-Erkennung und
 * des Haptik-Impulses. Zwei Kopien heissen zwei Orte, an denen eine Korrektur
 * vergessen werden kann; die Ausnahme für den Sortiergriff (#678) stand
 * folgerichtig auch nur in einer davon.
 *
 * Das CSS-Vokabular (`.swipe-row`, `.swipe-reveal`, der Chevron-Hint) liegt
 * seit jeher geteilt in layout.css - nur der JS-Teil fehlte.
 */

import { vibrate, durationToken } from '/utils/ux.js';
import { t } from '/i18n.js';

export const SWIPE_THRESHOLD = 80;   // px - Mindestweg für Aktion
export const SWIPE_MAX_VERT  = 12;   // px - vertikaler Toleranzbereich
export const SWIPE_LOCK_VERT = 30;   // px - ab diesem Weg gilt es als Scroll

// Dauer der Rückfeder-Animation in resetCard(); die Konstante hält sie mit dem
// Zeitpunkt zusammen, an dem die Compositor-Ebene wieder freigegeben wird.
// Aus dem Token (--duration-lg), nicht als Zahl: die Inline-Transition unten
// zeigt auf dieselbe Custom Property, der Timer muss dieselbe Dauer kennen.
const SWIPE_RESET_MS = durationToken('--duration-lg', 250);
// Dauer des Hinausfliegens nach einer ausgeloesten Aktion (--duration-md).
const SWIPE_FLY_MS = durationToken('--duration-md', 200);

const SWIPE_HINT_KEY = 'yuvomi:swipeHintSeen';
const SWIPE_HINT_MAX = 3;
const SWIPE_SWAP_KEY = 'yuvomi:swipeSidesSwapped';
const SWIPE_PRIOR_KEY = 'yuvomi:swipePriorInstall';

/**
 * Hatte dieser Browser die App schon VOR dem Seitentausch?
 *
 * Nur wer die alte Zuordnung kannte, hat etwas umzulernen; einer frischen
 * 2.0.0-Installation „die Seiten wurden getauscht" zu melden, erklärt einen
 * Zustand, den sie nie hatte.
 *
 * Der Beleg ist `swipeHintSeen`: den Zähler schrieb schon 1.x beim Öffnen von
 * Aufgaben und Einkauf. Er taugt aber nur, solange 2.0 ihn noch nicht selbst
 * gesetzt hat - deshalb steht die Frage HIER, beim Laden des Moduls, und nicht
 * im Wisch-Handler: `maybeShowSwipeHint()` schreibt den Zähler beim ersten
 * Render, also Millisekunden später. Die Antwort friert einmalig ein.
 *
 * Wer vor dem Update nie gewischt hat, gilt als neu - richtig so, auch dort
 * gibt es keine Gewohnheit gegen die neue Zuordnung.
 */
function rememberPriorInstall() {
  try {
    if (localStorage.getItem(SWIPE_PRIOR_KEY)) return;
    localStorage.setItem(SWIPE_PRIOR_KEY, localStorage.getItem(SWIPE_HINT_KEY) ? '1' : '0');
  } catch { /* Storage gesperrt (Safari privat): dann eben ohne Hinweis */ }
}
rememberPriorInstall();

/**
 * Einmaliger Hinweis, dass die Seiten getauscht wurden - beim ersten
 * ausgeführten Wisch nach dem Update, nicht beim Öffnen einer Seite.
 *
 * Der Merker ist geteilt, der Auslöser nicht: gelernt wird die GESTE, nicht die
 * Liste (derselbe Grund wie beim Nudge-Zähler) - wer in Aufgaben umlernt, hat es
 * im Einkauf schon gelernt, und der Hinweis kommt genau einmal. Auslösen dürfen
 * ihn aber nur die beiden Listen, in denen tatsächlich etwas getauscht hat:
 * Geburtstage und Abos hatten vor 2.0.0 überhaupt keine Geste, dort wäre die
 * Meldung schlicht unwahr.
 *
 * Der Text nennt keine Seite. „Rechts" wäre in `ar` und `fa` falsch, und die
 * Zeile, die der Nutzer gerade gewischt hat, zeigt ihm die neue Zuordnung
 * ohnehin gerade an.
 */
function noticeSwappedSides() {
  try {
    if (localStorage.getItem(SWIPE_PRIOR_KEY) !== '1') return;
    if (localStorage.getItem(SWIPE_SWAP_KEY)) return;
    localStorage.setItem(SWIPE_SWAP_KEY, '1');
  } catch { return; }
  window.yuvomi?.showToast(t('common.swipeSidesSwapped'), 'default', 6000);
}

/**
 * Verdrahtet alle `.swipe-row` unterhalb von `listEl`.
 *
 * Eine Geste wird über das PANEL benannt, das sie aufdeckt, nicht über die
 * physische Richtung: `leading` liegt am Zeilenanfang, `trailing` am Zeilenende,
 * und die Karte gibt das jeweils andere Ende frei. Welche Fingerbewegung das
 * ist, entscheidet die Schreibrichtung - in `ar` und `fa` (die App setzt
 * `dir=rtl`) sind Anfang und Ende gespiegelt. Solange die Optionen `left` und
 * `right` hiessen, drehte RTL die Bedeutung mit, ohne dass jemand etwas ändert.
 *
 * Jede Seite ist optional; fehlt sie, läuft ein Wisch dorthin ins Leere und
 * die Karte federt zurück. `run` bekommt die Zeile und darf asynchron sein.
 *
 * @param {HTMLElement} listEl                     - Container der Zeilen
 * @param {Object} opts
 * @param {string} opts.card                       - Selektor der Karte IN der Zeile
 * @param {string} [opts.ignore]                   - Selektor, an dem die Geste einem
 *                                                   anderen Zweck gehört (Sortiergriff)
 * @param {Object} [opts.leading]                  - Panel am Zeilenanfang
 * @param {string} opts.leading.reveal             - Selektor des Reveal-Panels
 * @param {boolean} [opts.leading.flyOut=false]    - Karte fliegt hinaus, statt zurückzufedern
 * @param {(row: HTMLElement) => any} opts.leading.run
 * @param {Object} [opts.trailing]                 - Panel am Zeilenende, gleiche Form
 * @param {boolean} [opts.sidesSwapped=false]      - Diese Liste hatte vor 2.0.0 schon eine
 *                                                   Geste, und zwar andersherum. Nur sie
 *                                                   darf den Umlern-Hinweis auslösen.
 */
export function wireSwipeRows(listEl, {
  card, ignore = null, leading = null, trailing = null, sidesSwapped = false,
} = {}) {
  if (!listEl || !card) return;

  const panels = [leading?.reveal, trailing?.reveal].filter(Boolean);

  // Die Schreibrichtung wird pro Geste gelesen, nicht beim Verdrahten: die
  // Sprache lässt sich ohne Reload wechseln, und die Zeilen bleiben dabei stehen.
  const sideFor = (dx) => (document.documentElement.dir === 'rtl'
    ? (dx < 0 ? leading : trailing)
    : (dx < 0 ? trailing : leading));

  listEl.querySelectorAll('.swipe-row').forEach((row) => {
    const cardEl = row.querySelector(card);
    if (!cardEl) return;

    let startX = 0, startY = 0;
    let dx = 0;
    let locked = false;       // false = unentschieden, 'swipe' | 'scroll'
    let thresholdHit = false; // Haptik am Schwellwert nur einmal

    const revealEl = (sel) => (sel ? row.querySelector(sel) : null);

    // Compositor-Versprechen: NUR fuer die Dauer einer Beruehrung, und nur auf
    // der beruehrten Zeile. Vorher stand `will-change: transform` als
    // Dauerregel im Stylesheet - im Demo-Seed 26 Einkaufszeilen und 11
    // Aufgabenkarten gleichzeitig, jede mit eigener Ebene samt Speicher
    // (Audit 2026-08-08, P2-1). Gesetzt wird bei `touchstart`, nicht erst bei
    // der ersten Bewegung: sonst faellt die Promotion in den ersten Frame der
    // Geste, also genau dorthin, wo sie stoert.
    let disarmTimer = null;
    function arm() {
      clearTimeout(disarmTimer);
      row.classList.add('swipe-row--armed');
    }
    function disarm(afterMs = 0) {
      clearTimeout(disarmTimer);
      if (!afterMs) { row.classList.remove('swipe-row--armed'); return; }
      // Die Rueckfeder-Animation laeuft noch; das Versprechen erst danach
      // einloesen, sonst verliert genau die letzte Bewegung ihre Ebene.
      disarmTimer = setTimeout(() => row.classList.remove('swipe-row--armed'), afterMs);
    }

    function resetCard(animate = true) {
      cardEl.style.transition = animate ? 'transform var(--duration-lg) var(--ease-out)' : '';
      cardEl.style.transform = '';
      row.classList.remove('swipe-row--swiping');
      disarm(animate ? SWIPE_RESET_MS : 0);
      for (const sel of panels) {
        const el = revealEl(sel);
        if (el) el.style.opacity = '0';
      }
    }

    row.addEventListener('touchstart', (e) => {
      // Geste ignorieren, solange ein Modal offen ist.
      if (document.getElementById('shared-modal-overlay')) return;
      // Am Sortiergriff gehört die Geste dem Ziehen (#678). Ohne diese Ausnahme
      // liefe beim Hochziehen einer Zeile das seitliche Wackeln als Wischweg mit
      // und die Karte rutschte unter dem Finger in ihre Aktion.
      if (ignore && e.target.closest?.(ignore)) { locked = 'scroll'; return; }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0;
      locked = false;
      thresholdHit = false;
      cardEl.style.transition = '';
      arm();
    }, { passive: true });

    // Ein abgebrochener Kontakt (Anruf, Systemgeste) laeuft nicht ueber
    // `touchend`; ohne diesen Zweig bliebe die Ebene stehen, bis die Zeile neu
    // gerendert wird.
    row.addEventListener('touchcancel', () => { resetCard(false); }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      if (locked === 'scroll') return;

      dx = e.touches[0].clientX - startX;
      const dy = Math.abs(e.touches[0].clientY - startY);

      // Scroll-Richtung früh erkennen
      if (locked === false) {
        if (dy > SWIPE_MAX_VERT && Math.abs(dx) < dy) {
          locked = 'scroll';
          resetCard(false);
          return;
        }
        if (Math.abs(dx) > SWIPE_MAX_VERT) locked = 'swipe';
      }
      if (locked !== 'swipe') return;

      // Vertikalen Scroll unterbinden, sobald der Wisch erkannt ist
      if (dy < SWIPE_LOCK_VERT) e.preventDefault();

      // Karte verschieben, jenseits der Schwelle gedämpft
      const dampened = dx > 0
        ? Math.min(dx, SWIPE_THRESHOLD + (dx - SWIPE_THRESHOLD) * 0.2)
        : Math.max(dx, -(SWIPE_THRESHOLD + (-dx - SWIPE_THRESHOLD) * 0.2));
      cardEl.style.transform = `translateX(${dampened}px)`;
      row.classList.add('swipe-row--swiping');

      // Reveal-Panels einblenden (0 → 1 über den Schwellwert)
      const progress = String(Math.min(Math.abs(dx) / SWIPE_THRESHOLD, 1));
      const shown = sideFor(dx)?.reveal;
      for (const sel of panels) {
        const el = revealEl(sel);
        if (el) el.style.opacity = sel === shown ? progress : '0';
      }

      if (!thresholdHit && Math.abs(dx) >= SWIPE_THRESHOLD) {
        thresholdHit = true;
        vibrate(15);
      }
    }, { passive: false });

    row.addEventListener('touchend', async () => {
      if (locked !== 'swipe') { resetCard(false); return; }

      const dir = Math.abs(dx) > SWIPE_THRESHOLD ? sideFor(dx) : null;
      if (!dir) { resetCard(true); return; }

      if (sidesSwapped) noticeSwappedSides();

      if (dir.flyOut) {
        // Die Karte verlässt das Bild, die Aktion läuft danach - so sieht man
        // das Ergebnis der Geste, bevor die Liste sich neu aufbaut.
        cardEl.style.transition = 'transform var(--duration-md) var(--ease-out)';
        cardEl.style.transform = `translateX(${dx < 0 ? '-' : ''}110%)`;
        vibrate(40);
        setTimeout(async () => {
          resetCard(false);
          await dir.run(row);
        }, SWIPE_FLY_MS);
        return;
      }

      resetCard(true);
      vibrate(20);
      await dir.run(row);
    }, { passive: true });
  });
}

/**
 * Nudge-Hinweis auf der ersten Zeile, höchstens SWIPE_HINT_MAX mal insgesamt.
 * Auf Zeigergeräten entfällt er - dort gibt es keine Wischgeste, und die
 * Zeilenaktionen stehen ohnehin sichtbar in der Zeile.
 *
 * Der Zähler ist bewusst app-weit und nicht pro Modul: gelernt wird die GESTE,
 * nicht die Liste.
 *
 * HÖCHSTENS EINMAL JE SEITENBESUCH, und zwar hier und nicht an den Aufrufstellen:
 * alle vier rufenden Module tun das aus einem Neu-Render-Pfad heraus
 * (`updateItemsList`, `bindContent`, `renderList`, `renderTaskList`), der auch an
 * Sortier-, Filter- und Löschvorgängen hängt. Ohne die Sperre verbrauchten drei
 * Filterklicks das Budget, bevor der Nutzer je eine Zeile gesehen hat, und die
 * Nudge-Animation spielte nach jedem Löschen erneut. Eine Regel im geteilten
 * Modul hält das an allen vier Stellen; vier richtig gesetzte Aufrufe wären vier
 * Annahmen, die beim nächsten Umbau wieder wandern.
 *
 * Der Pfad ist der Schlüssel und nicht ein Flag: wer die Seite verlässt und
 * wiederkommt, darf den Hinweis erneut sehen, solange das Budget reicht.
 */
let hintShownForPath = null;

export function maybeShowSwipeHint(container) {
  if (window.innerWidth >= 1024) return;
  if (hintShownForPath === location.pathname) return;

  // try/catch wie in noticeSwappedSides: bei blockiertem Storage (Safari privat)
  // wirft schon `getItem`, und dieser Aufruf steht mitten im Render-Pfad -
  // in `shopping.js` sogar VOR `updateCheckedActions()`.
  let count = 0;
  try {
    count = parseInt(localStorage.getItem(SWIPE_HINT_KEY) ?? '0', 10) || 0;
  } catch { return; }
  if (count >= SWIPE_HINT_MAX) return;

  const firstRow = container.querySelector('.swipe-row');
  if (!firstRow) return;

  firstRow.classList.add('swipe-row--hint');
  firstRow.addEventListener('animationend', () => {
    firstRow.classList.remove('swipe-row--hint');
  }, { once: true });

  hintShownForPath = location.pathname;
  try {
    localStorage.setItem(SWIPE_HINT_KEY, String(count + 1));
  } catch { /* der Hinweis lief, nur das Merken schlug fehl */ }
}
