/**
 * Modul: Scroll-Restoration für den SPA-Router
 * Zweck: Merkt den Scrollstand je History-Eintrag - `#main-content` und die
 *   benannten inneren Ports (`data-scroll-port`) -, damit eine Navigation oben
 *   beginnt und ein Browser-Zurück/-Vor dort weitermacht, wo der Nutzer stand.
 * Abhängigkeiten: keine Importe. Die DOM-Helfer nehmen Wurzel und History als
 *   Parameter, damit sie mit Attrappen testbar bleiben.
 */

// Der Scrollport der App überlebt jede Navigation: `#main-content` IST
// `.app-content` (renderAppShell), und renderPage() tauscht nur dessen Inhalt
// per replaceChildren(). Der Knoten behält damit den Scrollstand der Vorseite,
// und die Zielseite öffnete mitten im Bestand - gemessen 2026-08-02 auf 375x812:
// von der Übersicht (scrollTop 1267) auf /tasks gewechselt, dort weiterhin 1267
// bei scrollHeight 2185. Auffällig wird das nur, wenn die Zielseite mindestens
// so lang ist wie die Vorseite war; sonst klemmt der Browser die Position selbst
// auf das neue Maximum, und der Fehler versteckt sich hinter dem Zufall.
//
// DIE RICHTUNG ENTSCHEIDET, NICHT DIE SEITENTRANSITION. Ein eigener Aufruf
// (pushState) heißt „neue Seite, oben anfangen"; Browser-Zurück/-Vor (popstate)
// heißt „dorthin, wo ich war". Die Slide-Richtung nach Nav-Reihenfolge, die der
// Router bis 2026-09-26 fuer seinen Seitenwechsel rechnete, taugte dafür nie: sie
// lieferte 'left' genauso für einen Vorwärts-Tap auf einen weiter links liegenden
// Nav-Eintrag (der Wechsel ist seitdem eine Blende ohne Richtung). Maßgeblich ist
// allein das pushState-Flag von navigate() - false kommt nur vom popstate-
// Handler und vom Erstladen, und beim Erstladen ist die Map leer.
//
// MERKEN STATT NUR NICHT-ZURÜCKSETZEN. Ein „bei popstate einfach nichts tun"
// bewahrt nicht die Position der Zielseite, sondern die der Seite, von der man
// gerade kommt - dass das gelegentlich gleich aussieht, ist Zufall.
//
// REICHWEITE (seit R22, D2): `#main-content` UND die inneren Scrollports.
// Neun Modul-Roots (.budget-page, .calendar-page, .contacts-page, .health-page,
// .meals-page, .notes-page, .pantry-page, .recipes-page, .shopping-page) sind
// `overflow: hidden` auf voller Höhe und scrollen einen inneren Container; dort
// steht `#main-content` immer auf 0. Bis R22 landete ein Zurück dort oben
// (gemessen in sieben Modulen: 200-300 px -> 0). Jetzt BENENNT jedes Modul
// seinen Port - `data-scroll-port="<name>"` neben der Rolle `.page-scrollport`
// - und der Router merkt sich beim Verlassen jeden benannten Port mit Stand
// > 0 und setzt ihn nach dem Render des Rückwegs wieder. Der Name, nicht die
// Klasse: er muss nach dem Neuaufbau DENSELBEN Bereich wiederfinden, und eine
// Seite kann mehrere Ports haben (Kalender-Ansichten, Liste + Detail).
// Ein Port, der beim Wiederherstellen noch zu kurz ist (die Zeilen kommen
// nach dem Render), wird nachgezogen, bis er die Höhe hat - höchstens
// PORT_RESTORE_MS lang und nie gegen eine Eingabe des Nutzers.
//
// SCHLÜSSEL IST DER HISTORY-EINTRAG (seit R22, D2), nicht mehr der Pfad. Wer
// eine Route zweimal in derselben Historie besuchte, teilte sich einen
// Eintrag: nach zweimal Zurück trug der erste Besuch die Position des
// zweiten. Jeder Eintrag bekommt deshalb beim Betreten einen `scrollKey` in
// `history.state` (adoptEntryKey); fehlt er (Kaltstart, ein Eintrag, den ein
// Modul ohne ihn schrieb), gilt der Pfad wie bisher.
const positions = new Map();

/** Wie lange ein zu kurzer Port nach dem Render nachgezogen wird. */
export const PORT_RESTORE_MS = 1500;

/**
 * Hält den Scrollstand eines Eintrags fest, bevor er verlassen wird.
 * @param {string} key - Eintragsschlüssel (`scrollKey`) oder Pfad ohne Query
 * @param {number} top - scrollTop von `#main-content`
 * @param {Record<string, number>|null} [ports] - Stände der benannten inneren Ports
 */
export function rememberScrollPosition(key, top, ports = null) {
  if (typeof key !== 'string' || !key) return;
  const value = Number(top);
  const main = Number.isFinite(value) && value > 0 ? value : 0;
  const named = {};
  let any = false;
  if (ports && typeof ports === 'object') {
    for (const name of Object.keys(ports)) {
      const v = Number(ports[name]);
      if (Number.isFinite(v) && v > 0) { named[name] = v; any = true; }
    }
  }
  // Oben stehende Seiten nicht eintragen: der Default liefert dieselbe 0, und
  // die Map bleibt auf die Einträge beschränkt, bei denen es etwas zu merken gibt.
  if (!main && !any) {
    positions.delete(key);
    return;
  }
  positions.set(key, { top: main, ports: any ? named : null });
}

/**
 * Zielposition von `#main-content` für eine Navigation.
 * @param {string} key - Eintragsschlüssel oder Zielpfad ohne Query
 * @param {{ restore?: boolean }} options - restore=true nur bei popstate
 * @returns {number} scrollTop, auf den der Scrollport gesetzt werden soll
 */
export function scrollPositionFor(key, { restore = false } = {}) {
  if (!restore) return 0;
  return positions.get(key)?.top ?? 0;
}

/**
 * Zielstände der benannten inneren Ports für eine Navigation.
 * @param {string} key
 * @param {{ restore?: boolean }} options
 * @returns {Record<string, number>|null}
 */
export function portPositionsFor(key, { restore = false } = {}) {
  if (!restore) return null;
  const ports = positions.get(key)?.ports;
  return ports ? { ...ports } : null;
}

/** Verwirft alle gemerkten Positionen (Sitzungsende, Tests). */
export function forgetScrollPositions() {
  positions.clear();
}

let _keySeq = 0;
/** Ein neuer Eintragsschlüssel - eindeutig je Sitzung, kurz genug fürs State-Objekt. */
export function newEntryKey() {
  _keySeq += 1;
  return `s${Date.now().toString(36)}${_keySeq.toString(36)}`;
}

/** Der Schlüssel eines `history.state`, oder null. */
export function entryKeyOf(state) {
  const key = state && typeof state === 'object' ? state.scrollKey : null;
  return typeof key === 'string' && key ? key : null;
}

/**
 * Gibt dem laufenden History-Eintrag einen Schlüssel, falls er keinen hat, und
 * liefert ihn. Der übrige State bleibt (der Router liest `path`, Dialoge ihren
 * Marker). Ohne History (Tests) oder bei einer Sperre des Browsers (zu viele
 * replaceState in kurzer Zeit) bleibt es beim Pfad als Schlüssel.
 * @param {History} history
 * @param {string} fallback - Pfad, falls kein Schlüssel geschrieben werden kann
 */
export function adoptEntryKey(history, fallback) {
  const state = history?.state;
  const known = entryKeyOf(state);
  if (known) return known;
  const key = newEntryKey();
  try {
    const base = state && typeof state === 'object' ? state : {};
    history.replaceState({ ...base, scrollKey: key }, '');
    return key;
  } catch {
    return fallback;
  }
}

/** Ist dieser Port der sichtbare? Geparkte Nachbarn (Kalender-Wischen) sind `inert`. */
function isLivePort(el) {
  return !(typeof el.closest === 'function' && el.closest('[inert]'));
}

/**
 * Die Stände aller benannten Ports unter `root`, die nicht oben stehen.
 * @param {Element|null} root - `#main-content`
 * @returns {Record<string, number>|null}
 */
export function captureScrollPorts(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  const out = {};
  let any = false;
  for (const port of root.querySelectorAll('[data-scroll-port]')) {
    const name = port.getAttribute('data-scroll-port');
    if (!name || name in out || !isLivePort(port)) continue;
    const top = Math.round(port.scrollTop);
    if (top > 0) { out[name] = top; any = true; }
  }
  return any ? out : null;
}

function findPort(root, name) {
  for (const port of root.querySelectorAll('[data-scroll-port]')) {
    if (port.getAttribute('data-scroll-port') === name && isLivePort(port)) return port;
  }
  return null;
}

/**
 * Setzt die benannten Ports unter `root` auf ihre gemerkten Stände. Ein Port,
 * den es noch nicht gibt oder der noch zu kurz ist, wird bei jeder Änderung
 * im Baum nachgezogen - bis er sitzt, bis `timeoutMs` um ist, bis das Signal
 * abbricht oder bis der Nutzer selbst scrollt/tippt (ihm wird nie
 * hinterhergezogen).
 * @param {Element|null} root
 * @param {Record<string, number>|null} targets
 * @param {{ signal?: AbortSignal|null, timeoutMs?: number }} [options]
 * @returns {() => void} beendet das Nachziehen
 */
export function restoreScrollPorts(root, targets, { signal = null, timeoutMs = PORT_RESTORE_MS } = {}) {
  const noop = () => {};
  if (!root || !targets || typeof root.querySelectorAll !== 'function') return noop;
  const pending = new Map(Object.keys(targets).map((name) => [name, targets[name]]));
  const apply = () => {
    for (const [name, top] of pending) {
      const port = findPort(root, name);
      if (!port) continue;
      if (Math.abs(port.scrollTop - top) > 1) port.scrollTop = top;
      if (Math.abs(port.scrollTop - top) <= 1) pending.delete(name);
    }
  };
  apply();
  if (!pending.size || signal?.aborted || typeof MutationObserver !== 'function') return noop;

  let done = false;
  let observer = null;
  let timer = null;
  const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  const stop = () => {
    if (done) return;
    done = true;
    observer?.disconnect();
    clearTimeout(timer);
    for (const type of inputs) root.removeEventListener(type, stop, true);
    signal?.removeEventListener?.('abort', stop);
  };
  observer = new MutationObserver(() => {
    apply();
    if (!pending.size) stop();
  });
  observer.observe(root, { childList: true, subtree: true });
  for (const type of inputs) root.addEventListener(type, stop, { capture: true, passive: true });
  signal?.addEventListener?.('abort', stop, { once: true });
  timer = setTimeout(stop, timeoutMs);
  return stop;
}
