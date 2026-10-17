/**
 * Modul: Stylesheet einer geteilten Komponente nachladen (Critique R19, optimize)
 * Zweck: Eine Komponente, die nicht beim Start gebraucht wird, laedt ihr Blatt
 *        selbst - und zeigt sich erst, wenn es da ist.
 * Abhaengigkeiten: keine
 *
 * WARUM: index.html verlinkte das Blatt jeder geteilten Komponente, weil der
 * Router genau EIN Seitenblatt je Route laedt (CONTRIBUTING "Page layout").
 * Damit lagen Datumsauswahl, Kategorien-Verwalter, Symbolauswahl,
 * Dokumentanhang und Bildschirmschoner auf JEDEM Start im Weg vor dem ersten
 * Bild, auch auf einem Telefon, das keine davon oeffnet. Gemessen am Telefon
 * (4x CPU, Fast 4G, HTTP/1.1): jede Datei belegt eine der sechs Verbindungen
 * und schiebt das kleine Startskript dahinter.
 *
 * DIE REGEL BLEIBT, NUR DER ORT WANDERT: Die Komponente stellt ihr Blatt sicher
 * (`ensureStyle`) und wartet darauf, bevor sie sich zeigt. Asynchron geoeffnete
 * Teile (Dialoge, Bildschirmschoner) warten mit `await ensureStyle(...)`.
 * Felder, die synchron in fremdes Markup gerendert werden (Datumsfeld,
 * Dokumentanhang, Kategorien-Verwalter), halten sich mit `holdUntilStyled()`
 * unsichtbar (`[data-style-pending]` in layout.css), bis das Blatt geladen ist.
 * Ihr Modul stoesst das Laden schon beim Import an, das Feld wartet also
 * praktisch nie - der Halt ist die Garantie fuer den Fall, dass es doch so ist.
 *
 * DIE KASKADE BLEIBT, WIE SIE WAR: Ein Blatt, das am Ende von <head> haengt,
 * stuende HINTER dem Seitenblatt und typography.css und gewaenne bei gleicher
 * Spezifitaet, wo es vorher verlor. Deshalb steht es vor dem Platzhalter
 * `<meta name="component-styles">` in index.html, genau an der Stelle, an der
 * die Links vorher standen. Fehlt der Platzhalter, haengt es am Ende.
 *
 * Ein Fehler beim Laden loest ebenfalls auf: ein fehlendes Blatt ist ein
 * Schoenheitsfehler, kein Grund, das Datumsfeld nie zu zeigen. Offline liefert
 * der Service Worker die Datei aus dem Precache (APP_SHELL in sw.js).
 *
 * EIN FEHLER IST NICHT ENDGUELTIG (Review #2049, Runde 2). Der kaputte Link
 * geht aus dem Dokument und sein Eintrag aus der Liste: der naechste Aufruf
 * laedt neu. Vorher blieb beides stehen, und jeder spaetere ensureStyle()
 * bekam das erledigte Versprechen - die Komponente blieb ungestylt bis zum
 * Neuladen, auch wenn das Netz laengst wieder da war.
 */

/** @type {Map<string, { link: HTMLLinkElement, ready: Promise<void>, settled: boolean }>} */
const own = new Map();

/**
 * Ohne Dokument (Modultests unter Node, ein Stub ohne <head>) gibt es kein Blatt
 * zu laden und nichts zu verstecken: dort gilt jedes als geladen.
 */
const noDom = () => typeof document === 'undefined' || !document.head
  || typeof document.querySelectorAll !== 'function' || typeof document.createElement !== 'function';

function loadedLink(href) {
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    if (link.getAttribute('href') === href && link.sheet) return link;
  }
  return null;
}

/**
 * Ist das Blatt geladen und angewandt? Synchron, fuer den Halt beim Rendern.
 * @param {string} href - z. B. '/styles/datepicker.css'
 */
export function isStyleReady(href) {
  if (noDom()) return true;
  return Boolean(loadedLink(href));
}

/**
 * Laedt das Blatt einmal je Dokument; jeder weitere Aufruf bekommt dasselbe
 * Versprechen. Loest auf, sobald das Blatt geladen ist oder scheiterte.
 * @param {string} href
 * @returns {Promise<void>}
 */
export function ensureStyle(href) {
  if (noDom() || loadedLink(href)) return Promise.resolve();
  const known = own.get(href);
  // Erledigt, aber ohne Blatt (gescheitert, oder der Link kam abhanden):
  // neu laden statt das alte Versprechen zu wiederholen.
  if (known?.link.isConnected && !known.settled) return known.ready;
  if (known) {
    known.link.remove();
    own.delete(href);
  }

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.componentStyle = '';
  const entry = { link, ready: null, settled: false };
  entry.ready = new Promise((resolve) => {
    link.addEventListener('load', () => { entry.settled = true; resolve(); }, { once: true });
    link.addEventListener('error', () => {
      entry.settled = true;
      link.remove();
      if (own.get(href) === entry) own.delete(href);
      resolve();
    }, { once: true });
  });
  const slot = document.head.querySelector('meta[name="component-styles"]');
  if (slot) slot.before(link);
  else document.head.appendChild(link);
  own.set(href, entry);
  return entry.ready;
}

/**
 * Haelt ein synchron gerendertes Element unsichtbar, bis sein Blatt da ist.
 * Ist es schon geladen, passiert nichts (kein Attribut, kein Flackern).
 * @param {Element|null} el
 * @param {string} href
 * @returns {Promise<void>}
 */
export function holdUntilStyled(el, href) {
  const ready = ensureStyle(href);
  if (!el || isStyleReady(href)) return ready;
  el.setAttribute('data-style-pending', '');
  ready.then(() => el.removeAttribute('data-style-pending'));
  return ready;
}

/**
 * Laedt das Blatt im Leerlauf vor, ohne zu warten - fuer Felder, die sich
 * synchron rendern (Datumsfeld, Dokumentanhang, Kategorien): bis jemand ein
 * Formular oeffnet, ist es da, und der Halt oben greift nie. Ohne DOM (Tests
 * unter Node) tut es nichts.
 * @param {string} href
 */
export function warmStyle(href) {
  if (noDom()) return;
  const run = () => { ensureStyle(href); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}
