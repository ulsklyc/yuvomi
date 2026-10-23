/**
 * Modul: Lange Listen - erst was im Bild steht, der Rest in Happen
 * Zweck: Der erste Aufbau einer langen Zeilenliste setzt fuer jede Zeile
 *   einen Platzhalter in ihrer Hoehe, zeichnet sofort nur die Zeilen, die im
 *   Bild stehen, und fuellt den Rest danach in kurzen Tasks auf.
 * Abhängigkeiten: utils/scroll-restore.js (laeuft gerade ein Rueckweg?)
 *
 * WARUM (Critique R22-F, F2.1; handoff-3): der Wechsel in die Aufgaben mit 261
 * Eintraegen hielt das alte Bild 276 ms lang (mobil, 4x CPU), der Einkauf mit
 * 260 Artikeln 216 ms, am Laptop 315 bzw. 396 ms - fast alles im Frame des
 * Seitenwechsels: rund 11.000 Knoten parsen, stylen und legen, obwohl ein
 * Bildschirm 10 bis 40 Zeilen zeigt. Gemessen mit nur 25 Zeilen blieb davon
 * die Haelfte; der Rest ist Arbeit fuer Zeilen, die niemand sieht.
 *
 * DER PLATZHALTER HAT DIE HOEHE DER ZEILE, die er vertritt
 * (`--row-pending-size`, dieselbe Content-Box wie das `contain-intrinsic-size`
 * des Moduls; die Haarlinie bringt `.row-carrier > * + *` mit). Damit stimmen
 * vom ersten Bild an: die Laenge des Bildlaufs, die Spaltenverteilung des
 * zweispaltigen Einkaufs (die Gruppen wandern nicht, wenn Zeilen nachkommen),
 * und die Zaehlung `:nth-child(n+20)` der D4-Regel. Welche Zeilen im Bild
 * stehen, entscheidet die GEOMETRIE nach dem Einsetzen, nicht ein Zeilen-
 * budget in DOM-Reihenfolge - im Einkauf stehen am Laptop die ersten Zeilen
 * zweier Spalten im Bild, die rechte beginnt mitten in der Liste.
 *
 * NUR DER ERSTE AUFBAU EINES TRAEGERS. Jeder weitere (Schreiben, Suche,
 * Filter) zeichnet ganz wie bisher: die Wege danach suchen ihre Zeile sofort
 * (Zeile hinausfliegen lassen, neue Aufgabe ins Bild rollen). Ebenso ganz,
 * wenn der Router gerade einen Scrollstand wiederherstellt (D2): der Rueckweg
 * soll an derselben Zeile stehen, und die Zeilen darueber muessen dafuer ihre
 * echte Hoehe haben. Eine Eingabe in die Liste, bevor sie voll ist, fuellt
 * sofort auf - was der Tipp ausloest, findet jede Zeile.
 *
 * DIE HAPPEN NACH DEM LEITFADEN `break-up-long-tasks` (modern-web-guidance):
 * eine Frist je Task, dann `scheduler.yield()`, ohne die API `setTimeout`.
 * Die Frist ist kurz (SLICE_MS), weil zu jedem Happen noch Stil und Layout
 * seiner Zeilen kommen, die erst nach dem Task anfallen.
 *
 * Startpfad-Regel (CONTRIBUTING, R22): keine API juenger als Chrome 87 /
 * Firefox 79 / Safari 14.1 ohne Rueckfall - `scheduler.yield` nur geprueft.
 */
import { isRestoringScroll } from './scroll-restore.js';

/** Klasse des Platzhalters (styles/list-row.css). */
export const ROW_PENDING_CLASS = 'row-pending';

/** So lange darf ein Happen Skript laufen, bevor er die Hand abgibt (ms). */
export const SLICE_MS = 8;

/** Ueber den Bildrand hinaus sofort gezeichnet: ein Viertel Bildschirm. */
const AHEAD = 0.25;

/** Laufende Fuellungen je Traeger - ein neuer Aufbau beendet den alten. */
const jobs = new WeakMap();
/** Traeger, die ihren ersten Aufbau hinter sich haben. */
const built = new WeakSet();

/**
 * Gibt die Hand an den Browser ab: `scheduler.yield()`, wo es ihn gibt, sonst
 * ein Task ueber `setTimeout`.
 * @returns {Promise<void>}
 */
export function yieldToMain() {
  const sched = typeof globalThis !== 'undefined' ? globalThis.scheduler : undefined;
  if (sched && typeof sched.yield === 'function') return sched.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * JE HAPPEN EIN BILD. `scheduler.yield()` gibt die Hand ab, laesst den
 * Browser aber nicht zwingend zeichnen - seine Fortsetzung hat Vorrang, und
 * gemessen liefen sieben Happen am Laptop in EINEN Frame von 213 ms
 * zusammen (Stil und Layout aller Zeilen am Stueck). Der naechste Happen
 * beginnt deshalb erst nach dem naechsten gezeichneten Bild: Frame, dann ein
 * Task. Verdeckt zeichnet der Browser nicht - dort genuegt der Task.
 * @returns {Promise<void>}
 */
export function afterNextPaint() {
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  if (visible && typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  return yieldToMain();
}

/** Kann diese Umgebung messen, was im Bild steht? (Node-Attrappen nicht.) */
function canMeasure(host) {
  return typeof window !== 'undefined'
    // Nur ob es die Groesse GIBT - sie zu lesen erzwingt schon ein Layout.
    && 'innerHeight' in window
    && typeof host?.getBoundingClientRect === 'function'
    && typeof host?.querySelectorAll === 'function';
}

/**
 * Fuellt sofort alles auf, was am Traeger noch aussteht. Fuer Wege, die eine
 * bestimmte Zeile brauchen (Deep-Link `?open=`, eine angesteuerte Zeile).
 * @param {Element|null} host
 */
export function flushRowFill(host) {
  const job = host ? jobs.get(host) : null;
  if (job) job.flush();
}

/**
 * Beginnt den Aufbau der Zeilen eines Traegers.
 *
 * `rows(items, render)` liefert das Markup fuer `items`: ganz, oder - beim
 * ersten Aufbau - je Zeile einen Platzhalter, dessen Zeile `render(item)`
 * spaeter baut. Nach dem Einsetzen des Markups zeichnet `start()` die
 * Platzhalter im Bild sofort und den Rest in Happen; `onRows` bekommt jede
 * neu gezeichnete Zeile (Zeichen, Markierungen).
 *
 * DIE GRUPPE ZUERST. Liegt eine Gruppe ganz ausserhalb des Bildes, wird keiner
 * ihrer Platzhalter gemessen: Gruppen schieben ihr Layout auf
 * (`content-visibility: auto`, Aufgaben und Einkauf schmal), und jedes Messen
 * darin zwang das Layout DIESER Gruppe nach - gemessen 16 kleine Layouts im
 * Frame des Wechsels (Aufgaben mobil, 4x CPU: 8 ms). Die Gruppe selbst hat
 * ihre Box immer.
 *
 * @param {Element} host  der Traeger, der den Aufbau ueberlebt (`#task-list`)
 * @param {{ progressive?: boolean, group?: string }} [opts]  `progressive`
 *   false: immer ganz zeichnen; `group`: Selektor der Gruppe um die Zeilen
 * @returns {{ lazy: boolean, rows: (items: any[], render: (item: any) => string) => string,
 *   start: (opts?: { onRows?: (rows: Element[]) => void }) => void }}
 */
export function beginRowFill(host, { progressive = true, group = null } = {}) {
  // Ein neuer Aufbau ersetzt die Zeilen; was der alte noch fuellen wollte,
  // haengt nicht mehr und wird verworfen.
  jobs.get(host)?.cancel();
  jobs.delete(host);
  const first = host ? !built.has(host) : false;
  if (host) built.add(host);
  const lazy = Boolean(progressive && first && canMeasure(host) && !isRestoringScroll());
  /** @type {{ item: any, render: (item: any) => string }[]} */
  const queue = [];

  const rows = (items, render) => {
    if (!lazy) return items.map((item) => render(item)).join('');
    return items.map((item) => {
      queue.push({ item, render });
      return `<div class="${ROW_PENDING_CLASS}" data-row-fill="${queue.length - 1}" aria-hidden="true"></div>`;
    }).join('');
  };

  const start = ({ onRows = null } = {}) => {
    if (!lazy || !queue.length) return;
    let cancelled = false;
    const live = () => !cancelled && host.isConnected;

    /** Ersetzt Platzhalter durch ihre Zeilen; zusammenhaengende in EINEM Parse. */
    const hydrate = (pending) => {
      const added = [];
      let i = 0;
      while (i < pending.length) {
        const run = [pending[i]];
        while (i + run.length < pending.length && run[run.length - 1].nextElementSibling === pending[i + run.length]) {
          run.push(pending[i + run.length]);
        }
        i += run.length;
        const head = run[0];
        if (!head.isConnected) continue;
        const parent = head.parentNode;
        const before = head.previousElementSibling;
        head.insertAdjacentHTML('beforebegin', run.map((ph) => {
          const slot = queue[Number(ph.getAttribute('data-row-fill'))];
          return slot ? slot.render(slot.item) : '';
        }).join(''));
        let node = before ? before.nextElementSibling : parent.firstElementChild;
        while (node && node !== head) { added.push(node); node = node.nextElementSibling; }
        for (const ph of run) ph.remove();
      }
      if (added.length) onRows?.(added);
      return added.length;
    };

    const remaining = () => [...host.querySelectorAll(`.${ROW_PENDING_CLASS}[data-row-fill]`)];

    /** Platzhalter im Bild und ein Viertel Bildschirm darunter. */
    const inSight = () => {
      const all = remaining();
      if (!all.length) return all;
      // Das erste Lesen legt das Layout; alle weiteren lesen es nur noch.
      const bottom = (window.innerHeight || 0) * (1 + AHEAD);
      const meets = (r) => r.height > 0 && r.bottom > 0 && r.top < bottom;
      const groupSeen = new Map();
      return all.filter((ph) => {
        const box = group ? ph.closest(group) : null;
        if (box) {
          if (!groupSeen.has(box)) groupSeen.set(box, meets(box.getBoundingClientRect()));
          if (!groupSeen.get(box)) return false;
        }
        return meets(ph.getBoundingClientRect());
      });
    };

    // Sofort: was im Bild steht, und ein Viertel Bildschirm darunter. EIN
    // Blick (jeder kostet ein Layout): eine Zeile, die kuerzer ist als ihr
    // Platzhalter, zieht den naechsten nach oben - der Vorlauf deckt das
    // (Aufgaben mobil: 65 statt 85,6 px, knapp ein Viertel).
    hydrate(inSight());

    const cleanup = () => {
      jobs.delete(host);
      host.removeEventListener('pointerdown', flush, true);
      host.removeEventListener('keydown', flush, true);
    };
    const flush = () => {
      if (!live()) { cleanup(); return; }
      hydrate(remaining());
      cancelled = true;
      cleanup();
    };
    const job = { cancel: () => { cancelled = true; cleanup(); }, flush };
    if (!remaining().length) return;
    jobs.set(host, job);
    host.addEventListener('pointerdown', flush, true);
    host.addEventListener('keydown', flush, true);

    (async () => {
      while (true) {
        await afterNextPaint();
        if (!live()) { cleanup(); return; }
        const rest = remaining();
        if (!rest.length) { cleanup(); return; }
        const deadline = performance.now() + SLICE_MS;
        let k = 0;
        // Je Happen ein paar Zeilen am Stueck (ein Parse), bis die Frist um ist.
        while (k < rest.length && performance.now() < deadline) {
          hydrate(rest.slice(k, k + 8));
          k += 8;
        }
      }
    })();
  };

  return { lazy, rows, start };
}

/**
 * Zeichen fuer nachgekommene Zeilen - nur die noch offenen Platzhalter `<i>`:
 * `createIcons` aus lucide-scope.js nimmt sonst auch schon gezeichnete
 * `<svg data-lucide>` noch einmal (`[data-lucide]`).
 * @param {Element[]} rows
 */
export function drawRowIcons(rows) {
  const lucide = typeof window !== 'undefined' ? window.lucide : null;
  if (!lucide) return;
  for (const row of rows) {
    for (const node of row.querySelectorAll('i[data-lucide]')) lucide.createIcons({ el: node });
  }
}
